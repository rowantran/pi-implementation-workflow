export { writePlanDocument as writePlanFixture } from "./fixtures/plan-document.mjs";

export function planFixture(overrides = {}) {
	const document = {
		schemaVersion: 2,
		readingOrder: ["store-workflow-records"],
		goal: "Keep workflow records with the delivery.\n",
		testing: "- Verify records survive cleanup in Git.\n",
		changes: [{
			id: "store-workflow-records", title: "Store workflow records", dependsOn: [],
			content: "Save records under .workflows/ to preserve the original request and plan.\n\n## Design\n\nFreeform prose needs no What or Why fields.\n",
		}],
		...overrides,
	};
	if (document.schemaVersion === 2) document.changes = document.changes.map((change) => ({ implemented: false, ...change }));
	return document;
}
