import * as vscode from "vscode";
import assert = require("assert");
import { capitalCase } from "change-case";

import ICommand from "./ICommand";
import { RUN, START_DEV_MODE } from "./constants";
import registerCommand from "./register";
import host from "../host";
import { ContainerConfig } from "../service/configService";
import { LiveReload } from "../debug/liveReload";
import { ControllerResourceNode } from "../nodes/workloads/controllerResources/ControllerResourceNode";
import { getContainer, waitForSync } from "../debug";
import { RemoteTerminal } from "../debug/remoteTerminal";
import { NhctlCommand } from "../ctl/nhctl";
import { validateData } from "../utils/validate";
import { ValidateFunction } from "ajv";

export interface ExecCommandParam {
  appName: string;
  workload: string;
  resourceType: string;
  commands: Array<string>;
  namespace: string;
  kubeConfigPath: string;
}

export default class RunCommand implements ICommand {
  command: string = RUN;
  node: ControllerResourceNode;
  container: ContainerConfig;
  isReload: boolean = false;
  terminal: RemoteTerminal;
  isAutoMode: boolean;

  disposable: Array<{ dispose(): any }> = [];

  constructor(context: vscode.ExtensionContext) {
    registerCommand(context, this.command, false, this.execCommand.bind(this));
  }

  async execCommand(...rest: any[]) {
    const [node, param] = rest as [
      ControllerResourceNode,
      { command: string; isAutoMode?: boolean } | undefined
    ];

    if (!node) {
      host.showWarnMessage("Failed to get node configs, please try again.");
      return;
    }

    this.node = node;
    this.container = await getContainer(node);
    this.isAutoMode = param?.isAutoMode || false;

    this.validateRunConfig(this.container);

    if (!param?.command) {
      const status = await node.getStatus(true);

      if (status !== "developing") {
        vscode.commands.executeCommand(START_DEV_MODE, node, {
          command: RUN,
          isAutoMode: this.isAutoMode,
        });
        return;
      }
    }

    await waitForSync(node, RUN);

    const name = `${capitalCase(node.name)} Process Console`;

    await this.startRun(name);
  }

  async startRun(name: string) {
    const { node } = this;

    await this.createRunTerminal(name);

    if (this.container.dev.hotReload === true) {
      const liveReload = new LiveReload(node, async () => {
        this.isReload = true;

        await this.terminal.restart();
      });

      this.disposable.push(liveReload);
    }

    this.disposable.push(
      vscode.window.onDidCloseTerminal(async (e) => {
        if ((await e.processId) === (await this.terminal.processId)) {
          this.dispose();
        }
      })
    );
  }

  async createRunTerminal(name: string) {
    const { container, node } = this;
    const { run } = container.dev.command;

    const command = NhctlCommand.exec({
      app: node.getAppName(),
      name: node.name,
      namespace: node.getNameSpace(),
      kubeConfigPath: node.getKubeConfigPath(),
      resourceType: node.resourceType,
      commands: run,
      shell: container.dev.shell,
    }).getCommand();

    const terminal = await RemoteTerminal.create({
      terminal: {
        name,
        iconPath: { id: "vm-running" },
      },
      spawn: {
        command,
        close: () => {
          if (!this.isReload) {
            this.dispose();
          }
          this.isReload = false;
        },
      },
    });
    terminal.show();

    this.terminal = terminal;
  }

  async dispose() {
    this.disposable.forEach((d) => d.dispose());
    this.disposable.length = 0;

    if (this.terminal) {
      this.terminal.dispose();
    }
  }

  validateRunConfig(config: ContainerConfig) {
    const schema = {
      $schema: "http://json-schema.org/schema#",
      type: "object",
      required: ["dev"],
      properties: {
        dev: {
          type: "object",
          required: ["command"],
          properties: {
            command: {
              type: "object",
              required: ["run"],
              properties: {
                run: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "string",
                  },
                },
              },
            },
          },
        },
      },
    };

    const valid = validateData(config, schema);

    let message = "please check config.";
    if (valid !== true) {
      message = `config \n${(valid as ValidateFunction)
        .errors!.map((e) => `${e.dataPath} ${e.message}`)
        .join("\n")}`;
    }

    assert.strictEqual(valid, true, message);
  }
}
