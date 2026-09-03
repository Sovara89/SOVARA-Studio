# CONTROLLED WORKFLOW

## studio-plan

Read-only planning gate.

For the requested ONE task:

- run workspace guard;
- inspect only what is relevant;
- propose exact architecture/files/steps;
- list risks;
- list verification commands/criteria;
- STOP.

No edits, installs, migrations, or implementation.

## studio-build

Allowed only after explicit human message:

`APPROVED: implement TASK-XXX according to the approved plan.`

Implement exactly ONE approved task.

If a significant new dependency/module/path is needed beyond the approved plan:
STOP and ask for approval.

At the end report:

- WORKSPACE ROOT
- MARKER FOUND
- GIT MODE
- TASK
- files created
- files modified
- implementation summary
- commands actually run
- results
- remaining TODO/BLOCKED
- STOP

## studio-review

Read-only adversarial review.

If Git is available, inspect real diff.
If not, inspect BUILD-declared changed files and all affected production code.

Output:
CRITICAL / HIGH / MEDIUM / LOW findings.

Never fix code.

## studio-verify

Read-only verifier.

Run actual available commands:

- build
- typecheck
- lint
- tests
- relevant integration tests

Report:
PASS / FAIL / BLOCKED / NOT AVAILABLE

Never fabricate PASS.

## Next task

Only human approval can start the next TASK.
