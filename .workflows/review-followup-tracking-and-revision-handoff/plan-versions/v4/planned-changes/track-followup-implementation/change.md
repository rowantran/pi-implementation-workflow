**What**

Use the single `implemented` field defined in `store-review-followups` for every original change and accepted followup. The implementer edits it in `change_metadata.json` through prepare/edit/finalize, setting it to true when it believes its work on that change is done and leaving it false otherwise.

Use the field to select work for the next implementer. Do not add an implementation file, evidence submission, per-change hashes, commit checks, or automatic status invalidation.

**Why**

This is a handoff marker, not a claim that review passed. A small boolean preserves the implementer's assessment without turning ordinary progress tracking into another verification system.

**Pseudocode**

Use `SavedChange` from `store-review-followups` and `WorkflowScope` from `combine-original-and-followup-scope`.

```text
type ImplementationWork:
    remaining: SavedChange[]
    reportedImplemented: SavedChange[]

procedure SelectImplementationWork(scope):
    work = ImplementationWork([], [])
    for each change in scope.changes:      # originals AND accepted followups
        if change.implemented:
            append change to work.reportedImplemented
        else:
            append change to work.remaining
    return work
```

Complexity: O(n) time and space for `n` active changes. No code inspection, Git ancestry query, or review interpretation is needed to select this list.

```text
procedure ValidateImplementationDraft(previous, candidate):
    allow the supported version-1-to-2 conversion, if needed
    require all change IDs, reading order, and requirement files remain unchanged
    for each change's metadata:
        require every field except implemented equals its previous value
        require implemented is boolean
        allow flag changes only for original changes and accepted followups
    return Valid
```

Complexity: O(b + n) local comparison time and space for `b` compared bytes and `n` changes. Existing snapshot capture, integrity checks, and expected-base validation add O(f log f) sorting work for `f` files and filesystem I/O.

Enable plan prepare/finalize in the first implementation session, even if there are no followups. Within the draft, permit editing `change_metadata.json` for active changes; use field-level finalization checks to prevent that permission from changing titles, dependencies, or followup requirements. Original requirement fields remain frozen while the flag is editable in later snapshots.

The implementer should inspect existing code before working on a false item, because it may already be implemented, especially in older workflows. It can set true without making another code change when it believes the requirement is already covered. It may set false again if it concludes more work remains. A partial run saves true only for changes it considers done; an interrupted update remains recoverable through the draft and version history.

True does not mean fully implemented according to plan, tested successfully, committed, pushed, or approved by review. It records the implementer's belief. Existing testing and delivery instructions still apply, but finalizing this flag does not verify them or require separate evidence. The flag does not change automatically after code edits, rebases, new followups, or failed review verdicts.

Review remains independent and includes every active change regardless of the flag. Findings agreed during review normally become new followups starting false, rather than silently rewriting the earlier implementer's assessment. The flag is excluded from review requirement fingerprints, so changing it alone does not invalidate a review. Finalization remains separate from Git commits; the implementer includes the saved snapshot in its normal delivery.
