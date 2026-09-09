export { writePlanDocument as writePlanFixture } from "./fixtures/plan-document.mjs";

export function planFixture(overrides = {}) {
	return {
		schemaVersion: 1,
		readingOrder: ["store-workflow-records"],
		goal: "Keep workflow records with the delivery.\n",
		testing: "- Verify records survive cleanup in Git.\n",
		changes: [{
			id: "store-workflow-records", title: "Store workflow records", dependsOn: [],
			content: "Save records under .workflows/ to preserve the original request and plan.\n\n## Design\n\nFreeform prose needs no What or Why fields.\n",
		}],
		...overrides,
	};
}
