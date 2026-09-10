import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Small valid document for tests; caller overrides are kept verbatim. */
export function makePlanDocument(overrides = {}) {
  const changes = overrides.changes ?? [{
    id: 'implement-change',
    title: 'Implement the change',
    dependsOn: [],
    content: '**What**\n\nImplement the requested behavior and keep the existing behavior covered.\n\n**Why**\n\nDeliver the requested change without regressions.',
  }];
  return {
    schemaVersion: 1,
    readingOrder: changes.map((change) => change.id),
    goal: 'Deliver the requested behavior.',
    testing: 'Run the focused tests and the full regression suite.',
    ...overrides,
    changes,
  };
}

/** Test/preview authoring helper. Never use this to modify finalized versions. */
export async function writePlanDocument(directory, document) {
  await rm(directory, { recursive: true, force: true });
  await mkdir(join(directory, 'planned-changes'), { recursive: true });
  await Promise.all([
    writeFile(join(directory, 'plan.json'), JSON.stringify({ schemaVersion: document.schemaVersion, readingOrder: document.readingOrder }, null, 2) + '\n'),
    writeFile(join(directory, 'goal.md'), document.goal),
    writeFile(join(directory, 'testing.md'), document.testing),
    ...(document.intro === undefined ? [] : [writeFile(join(directory, 'intro.md'), document.intro)]),
    ...document.changes.map(async ({ id, title, dependsOn, content }) => {
      const path = join(directory, 'planned-changes', id);
      await mkdir(path, { recursive: true });
      await Promise.all([
        writeFile(join(path, 'change_metadata.json'), JSON.stringify({ title, dependsOn }, null, 2) + '\n'),
        writeFile(join(path, 'change.md'), content),
      ]);
    }),
  ]);
}
