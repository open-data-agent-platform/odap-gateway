# LangGraph

Install the [shared package](../python/README.md) with `[langgraph]` and supply
a host-approved `verifier`.

```python
from langchain_core.messages import AIMessage
from odap_integrations.langgraph import create_graph

graph = create_graph(verifier)
result = await graph.ainvoke({'messages': [AIMessage(content='', tool_calls=[{
    'name': 'odap_verify_evidence',
    'args': {'evidence_ref': '9007199254740993', 'correlation_id': 'request_1'},
    'id': 'verification_1',
}])]})
message = result['messages'][-1]
assert message.status == 'success'  # Tool success, not warehouse success.
```

The model-free graph uses LangGraph 1.2.22 `StateGraph` and `ToolNode`, with
the same LangChain tool. Rejected evidence produces an error ToolMessage.
There is no model call, persistence/checkpointer, hosted deployment, new approval,
query dispatch or remote cancellation. Applications adding those capabilities
must preserve these error and trust boundaries.

Code: [`odap_integrations.langgraph`](../python/src/odap_integrations/langgraph.py).
API: [Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api).
