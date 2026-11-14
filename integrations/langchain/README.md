# LangChain

Install the [shared package](../python/README.md) with `[langchain]` and supply
a host-approved `verifier`.

```python
from odap_integrations.langchain import create_tool
from langchain_core.tools import ToolException

tool = create_tool(verifier)
try:
    result = await tool.ainvoke({
        'evidence_ref': '9007199254740993',
        'correlation_id': '9223372036854775807',
    })
except ToolException:
    # Record a failed verification, not a successful query receipt.
    raise
```

The adapter uses langchain-core 1.8.0's actual `StructuredTool`, with strict
string inputs and extra arguments refused. It is async-only. It does not
instantiate a language model or send traces. The application owns any callback
or tracing configuration and must review metadata before exporting it.

Code: [`odap_integrations.langchain`](../python/src/odap_integrations/langchain.py).
API: [StructuredTool](https://reference.langchain.com/python/langchain-core/tools/structured/StructuredTool).
This is an independent ODAP module, not a LangChain core contribution or an
alternative to its community proposal process.
