# LlamaIndex

Install the [shared package](../python/README.md) with `[llamaindex]` and supply
a host-approved `verifier`.

```python
from odap_integrations.llamaindex import create_tool

tool = create_tool(verifier)
result = await tool.acall(evidence_ref='9007199254740993', correlation_id='request_1')
if result.is_error:
    raise RuntimeError('Evidence verification failed')
print(result.raw_output)
```

The adapter implements llama-index-core 0.14.26's `AsyncBaseTool` and returns
`ToolOutput`. Input rejection and evidence failure explicitly set `is_error`;
they are not ordinary successful text responses. Synchronous invocation is
unsupported. No model, query engine, vector store or external retrieval call
is configured.

Code: [`odap_integrations.llamaindex`](../python/src/odap_integrations/llamaindex.py).
API: [LlamaIndex tools](https://developers.llamaindex.ai/python/framework/module_guides/deploying/agents/).
This standalone integration is maintained by ODAP, not shipped by LlamaIndex.

Host-registered [opaque reference labels](../python/README.md#opaque-references)
can include URI punctuation, up to 512 printable ASCII characters. The tool
only performs exact lookup in its authorized registry; it does not fetch an
external receipt or accept its format. `raw_output.evidenceRef` is the label;
`receiptId` and `digest` remain those of the pinned ODAP artifact. An AER-1 ID
can be a host-chosen label within those limits, not evidence of AER-1 verification.

The consumer must check `is_error` before using `raw_output`, and keep
`status` separate from `recordedOutcome`. A verified bundle can describe a
cancelled or failed query. No free-form model-summary correctness, durable
"not checked" ledger, query submission or lost-acknowledgement handling is
validated by this tool. Those are separate application-level responsibilities.
