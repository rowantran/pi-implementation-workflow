<!-- Usage: Sent as the initial user message after /workflow-next switches to the review phase session. -->
Review pull request {{{pullRequestUrl}}}.

First inspect the original top-level ask in {{{metadataPath}}}, the approved plan in {{{planPath}}}, and later clarifications to the plan in {{{clarificationsPath}}}.

Then examine what the pull request actually implements, relative to the original sources above.
Ensure that the implemented pull request is both:
- Necessary: does not go beyond the scope of the original plan.
    - We usually should not go overboard and think about every possible hardening opportunity.
    - If we have a legitimate reason to modify existing code, even if it wasn't explicitly mentioned in the plan, because it results in a cleaner & more understandable system overall, that is acceptable even if it's not strictly necessary.
- Sufficient: actually implements the plan successfully.

Check for architectural cleanliness and adherence to the original intent.
Feel free to delegate to subagents to more effectively branch out and explore the diff.

Present your report roughly in the following format, making sure to keep your wording concise (see the /concise-output skill once you start writing the report, if I have it installed):
1. Your overall findings re: necessity & sufficiency
2. Key contracts, protocols, and data types added in the PR
    - Ground each one in the actual code, with short examples of usage.
        - For types: show the fields and how they're constructed
        - For contracts and protocols: show the type signatures and which components they bridge.
3. Any concerns or things that you believe should change, ordered from highest to lowest priority
