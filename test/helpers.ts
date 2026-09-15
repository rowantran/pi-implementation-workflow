import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodeExec } from "../src/git.ts";

export async function temporaryDirectory(prefix = "pi-workflow-test-"): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
	for (const [name, content] of Object.entries(files)) {
		const path = join(root, name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content);
	}
}

export const VALID_PLAN: Record<string, string> = {
	"plan.json": JSON.stringify({
		title: "Queue redrive with retry policy",
		readingOrder: ["define-policy", "implement-redrive"],
		changes: {
			"define-policy": { title: "Define the redrive policy", dependsOn: [], implemented: false },
			"implement-redrive": { title: "Implement queue redrive", dependsOn: ["define-policy"], implemented: false },
		},
	}, null, 2),
	"goal.md": "Failed queue messages can be redriven safely.\n",
	"intro.md": "The queue currently drops failed messages.\n",
	"testing.md": "- A user redrives a failed message and it is processed again.\n",
	"changes/define-policy.md": "**What**\n\nA policy type.\n\n## Testing\n\n- Policy parses from config.\n",
	"changes/implement-redrive.md": "**What**\n\nThe redrive loop.\n\n## Testing\n\n- Redrive retries three times.\n",
};

export async function initRepository(): Promise<string> {
	const root = await temporaryDirectory("pi-workflow-repo-");
	// Some sandboxes forbid nested .git directories; a separate git dir keeps the checkout a plain directory.
	for (const args of [
		["init", "-q", "-b", "main", `--separate-git-dir=${root}.git-dir`],
		["config", "user.email", "test@example.com"],
		["config", "user.name", "Test"],
		["config", "commit.gpgsign", "false"],
	]) await nodeExec("git", ["-C", root, ...args]);
	await writeFile(join(root, "README.md"), "hello\n");
	await nodeExec("git", ["-C", root, "add", "."]);
	await nodeExec("git", ["-C", root, "commit", "-q", "-m", "initial"]);
	return root;
}
