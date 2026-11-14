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
