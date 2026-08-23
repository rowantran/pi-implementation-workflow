<!-- Usage: Sent as the initial user message after /workflow-next switches to the implementation phase session. -->
Implement the plan.

First inspect the immutable original ask in {{{metadataPath}}}, the frozen plan in {{{planPath}}}, and relevant existing code from the repository.

Before you start changing code, if there are any design choices that are left ambiguous by the sources above or contain contradictions, resolve the remaining ambiguity by using the implementation questionnaire to ask clarifying questions.
Lean towards asking more clarifying questions than less. At the same time, do not waste effort reopening design choices that are already clearly resolved by the existing sources.

Once done resolving ambiguity, proceed with the implementation.
