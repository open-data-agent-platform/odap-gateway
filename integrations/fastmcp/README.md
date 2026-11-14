# FastMCP

Install the [shared package](../python/README.md) with `[fastmcp]`, build the
Gateway verifier, and construct the host-approved `verifier` as documented there.

```python
from odap_integrations.fastmcp import create_server
from fastmcp import Client

server = create_server(verifier)
async with Client(server) as client:
    result = await client.call_tool_mcp('odap_verify_evidence', {
        'evidence_ref': '9007199254740993',
        'correlation_id': '9223372036854775807',
    })
    if result.is_error:
        raise RuntimeError('Evidence verification failed')
    print(result.structured_content)
```

This uses FastMCP 4.2.0 and MCP Python SDK 2.3.0. Tests cover `auto` and
`legacy` in-memory clients and a real loopback HTTP server. The returned server
does not start a listener or configure authentication. A public server requires
host-managed authentication and caller-scoped registries; a read-only annotation
is not an access-control mechanism.

Tool input contains only two strings. It has no SQL, path, tenant override,
credentials or job-cancellation operation. The actual code is in
[`odap_integrations.fastmcp`](../python/src/odap_integrations/fastmcp.py).
See [FastMCP tools](https://gofastmcp.com/servers/tools) for the framework API.
