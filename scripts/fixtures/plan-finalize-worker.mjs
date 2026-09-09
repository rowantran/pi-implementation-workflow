import { createJiti } from "jiti/static";
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { finalizePlanDraft } = await jiti.import(new URL("../../src/plan-storage.ts", import.meta.url).pathname);
process.on("message", async ({ files, expectedBaseVersion }) => {
  try {
    const version = await finalizePlanDraft(files, "Concurrent finalize", expectedBaseVersion);
    process.send({ ok: true, number: version.number });
  } catch (error) {
    process.send({ ok: false, message: error.message });
  } finally { process.disconnect(); }
});
process.send({ ready: true });
