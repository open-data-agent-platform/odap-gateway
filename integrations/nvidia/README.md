# NVIDIA Auto Ontology

The existing [offline SQL attribute import](../../docs/NVIDIA_IMPORT.md) is
part of the Gateway and is indexed here without duplicating its implementation.

- Source: a detail-response envelope pinned to commit
  `c447003f72a822301e927196a4ecb5b597c308d5`.
- Code: [`lib/nvidia-semantic-import.ts`](../../lib/nvidia-semantic-import.ts).
- Command: [`scripts/stage-nvidia-import.ts`](../../scripts/stage-nvidia-import.ts).
- Validation: import, CLI and authenticated candidate-storage tests under `tests/`.

Upstream certification remains an unverified upstream claim. It never grants
Gateway release approval, local roles or execution authority. The operator
supplies an explicit metric mapping; the adapter does not infer SQL equivalence.
Live upstream access, real business data and independent integration acceptance
remain outside this offline adapter.
