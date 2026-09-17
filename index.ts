/**
 * pi-plan: a master Pi session spawns single-task agents in tmux windows and
 * collects their reports. The same extension serves both roles; an agent is
 * any process spawned with the socket env var set.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Injected into an agent terminal; its presence marks the agent role. */
const SOCKET = "PI_PLAN_AGENT_SOCKET";
const isAgent = (): boolean => Boolean(process.env[SOCKET]);

/** Assistant content is structurally simple; narrow to what the report needs. */
interface AssistantMessageLike {
	content?: Array<{ type: string; text?: string }>;
}

/** Resolve on the first newline-delimited frame. */
function readFrame(socket: net.Socket): Promise<string> {
	return new Promise((resolve) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const index = buffer.indexOf("\n");
			if (index >= 0) resolve(buffer.slice(0, index));
		});
	});
}

export default function piPlan(pi: ExtensionAPI): void {
	// ---- Agent: one task in, one summary out ------------------------------
	if (isAgent()) {
		const socket = net.connect(process.env[SOCKET] as string);
		let pending: string | null = null;

		pi.on("session_start", async () => {
			const { prompt } = JSON.parse(await readFrame(socket));
			pi.sendUserMessage(prompt);
		});

		pi.on("agent_end", (event) => {
			const message = event.messages.findLast(
				(candidate) => candidate.role === "assistant",
			) as AssistantMessageLike | undefined;
			const text = (message?.content ?? [])
				.filter((block) => block.type === "text")
				.map((block) => block.text ?? "")
				.join("\n")
				.trim();
			pending = text || "(no output)";
		});

		pi.on("agent_settled", () => {
			if (pending === null) return;
			socket.write(`${JSON.stringify({ summary: pending })}\n`);
			pending = null;
		});
		return;
	}

	// ---- Master: tmux frontend only ---------------------------------------
	if (!process.env.TMUX) return;

	pi.registerTool({
		name: "spawn_agent",
		label: "Spawn Agent",
		description: "Spawn a single-task agent Pi session in a new terminal and return its report.",
		parameters: Type.Object({
			task: Type.String({ description: "The task the agent must complete." }),
		}),
		async execute(_id, params) {
			const dir = path.join(os.homedir(), ".pi-plan");
			await fs.mkdir(dir, { recursive: true });
			const name = `agent-${randomBytes(4).toString("hex")}`;
			const socketPath = path.join(dir, `${name}.sock`);

			await fs.rm(socketPath, { force: true });
			const server = net.createServer();
			server.listen(socketPath);
			await once(server, "listening");

			const reply = new Promise<string>((resolve) => {
				server.once("connection", async (socket) => {
					server.close();
					socket.write(`${JSON.stringify({ prompt: params.task })}\n`);
					resolve(await readFrame(socket));
					socket.end();
				});
			});

			const { stdout } = await exec(
				"tmux",
				[
					"new-window", "-d", "-P", "-F", "#{window_id}", "-n", name,
					"-c", process.cwd(), "-e", `${SOCKET}=${socketPath}`,
					"pi", "--name", name,
				],
				{ encoding: "utf8" },
			);
			const windowId = stdout.trim();

			try {
				const { summary } = JSON.parse(await reply);
				return {
					content: [{ type: "text" as const, text: summary || "(no output)" }],
					details: undefined,
				};
			} finally {
				await exec("tmux", ["kill-window", "-t", windowId]).catch(() => {});
				await fs.rm(socketPath, { force: true });
			}
		},
	});

	pi.registerCommand("plan", {
		description: "Plan and carry out any task with agents",
		handler: async (args, commandCtx) => {
			const goal = args.trim();
			if (!goal) {
				commandCtx.ui.notify("pi-plan: usage: /plan <goal>", "warning");
				return;
			}
			pi.sendUserMessage(
				`Orchestrate only: spawn agents for the work and decide from their reports.\n\nGoal: ${goal}`,
			);
		},
	});
}
