import * as vscode from "vscode";
import * as path from "path";
const isWindows = require("is-windows");

import ICommand from "./ICommand";
import { COPY_TERMINAL } from "./constants";
import registerCommand from "./register";
import host from "../host";
import { ControllerNodeApi } from "./StartDevModeCommand";
import * as shell from "../ctl/shell";
import { NhctlCommand, getContainers, getPodNames } from "../ctl/nhctl";
import { DeploymentStatus } from "../nodes/types/nodeType";
import { Pod } from "../nodes/workloads/pod/Pod";
import { ExecOutputReturnValue } from "shelljs";

export default class CopyTerminalCommand implements ICommand {
  command: string = COPY_TERMINAL;
  static defaultShells = ["zsh", "bash"];
  constructor(context: vscode.ExtensionContext) {
    registerCommand(context, this.command, false, this.execCommand.bind(this));
  }
  async execCommand(node: ControllerNodeApi) {
    if (!node) {
      host.showWarnMessage("Failed to get node configs, please try again.");
      return;
    }
    await host.showProgressing("copying ...", async () => {
      await this.exec(node);
    });
  }

  async exec(node: ControllerNodeApi | Pod) {
    if (!(node instanceof Pod)) {
      const status = await node.getStatus();
      let container = "";
      let pod = "";
      if (status === DeploymentStatus.developing) {
        container = "nocalhost-dev";
        pod = "";
      } else {
        const result = await this.getPodAndContainer(node);
        if (!result || !result.containerName || !result.podName) {
          return;
        }
        container = result.containerName;
        pod = result.podName;
      }
      await this.openDevSpaceExec(
        node.getAppName(),
        node.name,
        node.resourceType,
        pod,
        container,
        node.getKubeConfigPath(),
        node.getNameSpace()
      );
      return;
    } else {
      await this.openExec(node);
    }
  }

  private async getDefaultShell(
    podName: string,
    containerName: string,
    kubeConfigPath: string
  ) {
    let defaultShell = "sh";
    for (let i = 0; i < CopyTerminalCommand.defaultShells.length; i++) {
      let notExist = false;

      const command = NhctlCommand.exec({
        kubeConfigPath,
      })
        .addArgument(podName)
        .addArgumentStrict("-c", containerName)
        .addArgumentTheTail(`-- which ${CopyTerminalCommand.defaultShells[i]}`)
        .getCommand();

      const shellObj = await shell.exec({ command }).promise.catch(() => {
        notExist = true;
      });
      if (notExist) {
        continue;
      } else {
        const result = shellObj as ExecOutputReturnValue;
        if (result.code === 0 && result.stdout) {
          defaultShell = CopyTerminalCommand.defaultShells[i];
          break;
        }
      }
    }

    return defaultShell;
  }

  async openDevSpaceExec(
    appName: string,
    workloadName: string,
    workloadType: string,
    pod: string,
    container: string,
    kubeConfigPath: string,
    namespace: string
  ) {
    const terminalCommands = ["dev", "terminal", appName];
    terminalCommands.push("-d", workloadName);
    terminalCommands.push("-t", workloadType);
    terminalCommands.push("--kubeconfig", kubeConfigPath);
    terminalCommands.push("-n", namespace);
    if (pod) {
      terminalCommands.push("--pod", pod);
    }
    if (container) {
      terminalCommands.push("-c", container);
    }

    this.copyCommand(`${NhctlCommand.nhctlPath} ${terminalCommands.join(" ")}`);
  }
  private copyCommand(command: string) {
    if (isWindows()) {
      command = command.replaceAll(path.sep, "\\\\");
    }

    host.copyTextToClipboard(command);

    host.showInformationMessage(
      "Please open the terminal and paste this command to open new shell."
    );
  }
  private async execCore(
    kubeConfigPath: string,
    podName: string,
    containerName: string,
    namespace: string
  ) {
    let shell = await this.getDefaultShell(
      podName,
      containerName,
      kubeConfigPath
    );

    const command = NhctlCommand.exec({
      kubeConfigPath: kubeConfigPath,
      namespace,
    })
      .addArgument("-it", podName)
      .addArgument("-c", containerName)
      .addArgumentTheTail(`-- ${shell || ""}`)
      .getCommand();

    this.copyCommand(command);
  }

  /**
   * exec
   * @param host
   * @param type
   * @param workloadName
   */
  async openExec(node: ControllerNodeApi | Pod) {
    const kubeConfigPath = node.getKubeConfigPath();
    let podName: string | undefined;
    if (node instanceof Pod) {
      podName = node.name;
    } else {
      const podNameArr = await getPodNames({
        name: node.name,
        kind: node.resourceType,
        namespace: node.getNameSpace(),
        kubeConfigPath: kubeConfigPath,
      });
      podName = podNameArr[0];
      if (podNameArr.length > 1) {
        podName = await vscode.window.showQuickPick(podNameArr);
      }
    }
    if (!podName) {
      return;
    }
    const containerNameArr = await getContainers({
      appName: node.getAppName(),
      resourceType: node.resourceType,
      name: node.name,
      kubeConfigPath: kubeConfigPath,
      namespace: node.getNameSpace(),
    });
    let containerName: string | undefined = containerNameArr[0];
    if (containerNameArr.length > 1) {
      containerName = await vscode.window.showQuickPick(containerNameArr);
    }
    if (!containerName) {
      return;
    }
    await this.execCore(
      kubeConfigPath,
      podName,
      containerName,
      node.getNameSpace()
    );
  }

  async getPodAndContainer(node: ControllerNodeApi | Pod) {
    const kubeConfigPath = node.getKubeConfigPath();
    let podName: string | undefined;
    let status = "";
    if (node instanceof Pod) {
      podName = node.name;
    } else {
      const podNameArr = await getPodNames({
        name: node.name,
        kind: node.resourceType,
        namespace: node.getNameSpace(),
        kubeConfigPath: kubeConfigPath,
      });
      podName = podNameArr[0];
      status = await node.getStatus();
      if (status !== DeploymentStatus.developing && podNameArr.length > 1) {
        podName = await vscode.window.showQuickPick(podNameArr);
      }
    }
    if (!podName) {
      return;
    }
    const containerNameArr = await getContainers({
      appName: node.getAppName(),
      name: node.name,
      resourceType: node.resourceType,
      kubeConfigPath: kubeConfigPath,
      namespace: node.getNameSpace(),
    });
    let containerName: string | undefined = containerNameArr[0];
    if (status !== DeploymentStatus.developing && containerNameArr.length > 1) {
      containerName = await vscode.window.showQuickPick(containerNameArr);
    }
    if (!containerName) {
      return;
    }

    return { containerName, podName };
  }
}
