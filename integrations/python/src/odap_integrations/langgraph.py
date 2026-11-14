"""A model-free LangGraph tool node; caller supplies tool-call messages."""

from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from .evidence import EvidenceVerifier
from .langchain import create_tool


def create_graph(verifier: EvidenceVerifier):
    graph = StateGraph(MessagesState)
    graph.add_node(
        "odap_evidence", ToolNode([create_tool(verifier)], handle_tool_errors=True)
    )
    graph.add_edge(START, "odap_evidence")
    graph.add_edge("odap_evidence", END)
    return graph.compile()
