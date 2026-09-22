# File-backed notifications

`notifications.ts` provides a small notification queue for processes on one host. A topic is a directory path chosen by the caller. The module uses only Node.js built-ins and has no application-specific concepts.

```ts
import { delivered, list, monitor, publish, recipients } from "./notifications.ts";

const consumer = await monitor<{ comments: string[] }>(
	"/some/shared/topic",
	{ id: "reader", label: "Reader", resume: "caller-defined resume data" },
	async (notification) => {
		await persistComments(notification.payload.comments);
		return true;
	},
);

await publish("/some/shared/topic", {
	id: "batch-1",
	recipientId: "reader",
	payload: { comments: ["Check this change"] },
});

await consumer.close();
```

## API

- `recipients(topic)` returns retained `{ id, label, resume?, active, registeredAt, updatedAt }` records, including inactive recipients, sorted by ID. Both timestamps use Unix milliseconds. `registeredAt` records the latest successful registration; it stays fixed through heartbeats and close, and a new registration replaces it. `updatedAt` records the latest heartbeat or close. Legacy records without `registeredAt` return `0`, never their heartbeat time. No process or ownership data is exposed.
- `publish(topic, { id, recipientId, payload })` returns `{ id, recipientId, createdAt, payload }`. `createdAt` is an ISO timestamp. The notification ID is unique within the topic. Repeating the same ID, recipient, and JSON payload returns the original message, including its original timestamp. Different content for that ID throws. Object key order does not affect equality.
- `list<T>(topic)` returns all retained notifications, including acknowledged ones, ordered by creation timestamp and then ID. This is a file scan, not a transaction snapshot across concurrent publishes.
- `delivered(topic, id)` returns whether a delivery receipt exists.
- `monitor<T>(topic, recipient, callback, { intervalMs?, onError? }?)` registers one consumer and scans at startup, then serially every 1,000 ms by default. Each scan delivers pending messages in creation-time order, breaking ties by ID; a corrupt file does not block other messages. Its promise returns a `{ close() }` handle without waiting for the first callback. Returning `true` writes a receipt. Returning `false` or throwing leaves the message pending for the next scan. Failures are passed to `onError`, if supplied. A throwing error reporter does not stop polling.
- `close()` cancels timers, prevents further callback starts, waits for an in-flight callback and its receipt, and marks the recipient inactive. Repeated calls share the same promise. Resume metadata is retained, including when a later registration omits it. Call `close()` outside the callback; awaiting it inside the callback would wait on itself.

IDs must contain 1–128 ASCII letters, digits, underscores, or hyphens. Payloads use JSON serialization: circular values, BigInt, and non-serializable root values are rejected; dates and other JSON conversions follow `JSON.stringify` rules.

Reading an absent topic never creates it. Registering or publishing creates the required directories. Messages and receipts are retained; the caller owns retention and topic cleanup.

The caller chooses routing policy. For example, select the most recently registered recipient by descending `registeredAt`, breaking ties by ascending ID. Do not use `updatedAt` for activation order: a heartbeat is not a new registration. An inactive recipient remains addressable, so callers can queue for it without falling back to an older active recipient. Once published, a notification's recipient cannot change.

## Storage and ownership

```text
<topic>/
  messages/<id>.json
  receipts/<id>.json
  recipients/<recipient-id>/<generation>.json
```

Publication uses a complete temporary file and an atomic hard link. This prevents partial JSON reads and ensures concurrent publishers cannot overwrite each other. Heartbeats and inactive status use atomic rename. Crash-left temporary files are ignored.

Only one monitor can own a recipient. Each registration claims a new numbered ownership file; old files remain so competing recovery attempts cannot remove a new owner's lock. A dead owner process can be replaced immediately. Heartbeats run at least once a second independently of callbacks; a heartbeat older than 30 seconds makes a recipient appear inactive. A live process keeps ownership even with a stale heartbeat, since its callback may still be running. PID reuse can therefore conservatively block recovery while the unrelated process lives. All timers are unreferenced and do not keep a process running.

This library assumes a trusted directory on a local filesystem with atomic hard links and renames. It is not a multi-host lock service. Retained ownership generations grow with registrations. Do not delete a topic while a monitor is open.

Delivery is **at least once**, not exactly once: a process can stop after the callback's side effect but before its receipt is saved. Make callback side effects idempotent using the notification ID, and return `true` only when the effect is durable. Atomic publication does not promise durability against power loss.
