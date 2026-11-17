# Local OpenLineage receiver-converter checks

This harness executes the actual `OpenLineageToDataHub.convertRunEventToJob`
and `DatahubJob.toMcps` methods bundled in the official
`io.acryl:acryl-spark-lineage_2.12:1.7.0.20` release. It does not substitute a
hand-written converter. Spark itself, listeners and remote emitters are not
started. The shaded Java artifact is an accessible distribution of the
converter, **not a running DataHub GMS HTTP receiver**.

Separate source inspection at DataHub commit
[`7039af1`](https://github.com/datahub-project/datahub/blob/7039af166b0933220b2d9c82a27e569801cbcfe7/metadata-service/openapi-servlet/src/main/java/io/datahubproject/openapi/openlineage/mapping/RunEventMapper.java)
confirms that the HTTP mapper calls these same two APIs. The
[HTTP controller](https://github.com/datahub-project/datahub/blob/7039af166b0933220b2d9c82a27e569801cbcfe7/metadata-service/openapi-servlet/src/main/java/io/datahubproject/openapi/openlineage/controller/LineageApiImpl.java)
then uses its authentication context and ingestion service. Neither that commit
nor its HTTP controller is claimed as the executed artifact: the runnable test
identity is the Maven coordinate and hash below. A matching `v1.7.0.20` Git tag
was not available when checked; no source revision is guessed from the version.

## Run

Use Node 24, the repository's installed npm dependencies, and JDK 21. The
JDK-21-only network tripwire intentionally fails on incompatible JVMs rather
than silently removing the check. Its deprecation warning is expected.

Obtain these two official artifacts over HTTPS before the offline test:

| Artifact | SHA-256 |
| --- | --- |
| [DataHub 1.7.0.20](https://repo.maven.apache.org/maven2/io/acryl/acryl-spark-lineage_2.12/1.7.0.20/acryl-spark-lineage_2.12-1.7.0.20.jar) | `c7feeda495fe2a4553b2f7a5874bc39722eb642fbfda3c0799ad8a08ca5513ea` |
| [SLF4J API 2.0.17](https://repo.maven.apache.org/maven2/org/slf4j/slf4j-api/2.0.17/slf4j-api-2.0.17.jar) | `7b751d952061954d5abfed7181c1f645d336091b679891591d63329c622eb832` |

DataHub publishes a SHA-256 sidecar; SLF4J's official SHA-1 sidecar was checked
over HTTPS and its SHA-256 is locked above. The harness independently checks
both SHA-256 values before compiling. It does not download dependencies, read
credentials, start containers, or configure a catalog endpoint. Its Java
classpath contains just the probe, the pinned release and SLF4J API. A logging
provider is deliberately not added; the upstream no-provider warning is kept.

From the Gateway repository root, with `JAVA_HOME` pointing to JDK 21:

```sh
export DATAHUB_CONVERTER_JAR=/absolute/path/acryl-spark-lineage_2.12-1.7.0.20.jar
export SLF4J_API_JAR=/absolute/path/slf4j-api-2.0.17.jar
export ODAP_RECEIVER_OUTPUT=.tmp/datahub-characterization
node --test --test-reporter=tap \
  integrations/datahub/receiver-tests/verify-receiver.mjs
```

To keep machine-readable reports, add Node's `--test-reporter=junit` and
`--test-reporter-destination` flags, giving both reporters separate destinations
outside the output directory (which the harness creates). Use a **new** output
directory for every run; previous results must not be overwritten.

The optional strict association gate requires evidence-digest retention rather
than accepting the observed converter behavior:

```sh
ODAP_REQUIRE_FACET_RETENTION=1 \
ODAP_RECEIVER_OUTPUT=.tmp/datahub-strict \
node --test integrations/datahub/receiver-tests/verify-receiver.mjs
```

A failed strict gate is a missing integration capability, not a successful test
or an allegation that DataHub promised to understand an ODAP-specific facet.
Characterization tests describe behavior; passing them does not fix that gap.

## Evidence boundary

The harness rebuilds the real Gateway detached exporter and creates synthetic
START/terminal cycles for success, failure and cancellation. Modified fixture
pins are computed solely for synthetic tests, not represented as independent
custody evidence. Inputs, decoded events, every generated MCP/aspect, process
exit codes, compiler/runtime logs and runtime versions are retained locally.

Coverage includes explicit/missing orchestrator configuration, exact timestamps,
native cancellation status, omitted physical datasets, facet retention at the
parser versus converter boundary, repeated/reversed/terminal-only events, and
same-run billing revisions. No global metadata cache or fake database is used.

This does **not** test the GMS HTTP controller, authentication, server-side model
validation, ingestion queue, persistence, duplicate-write suppression, retention,
search indexing, UI rendering or any production pilot. Repeated identical MCPs
do not prove idempotent writes; accepted reversed inputs do not establish server
ordering behavior. A separate authorized local service fixture is still needed
for those layers. This harness does not change Gateway runtime behavior, the
OpenLineage exporter, DataHub's schema or its converter implementation.

The separate [direct SDK snapshot adapter](../README.md) retains allowlisted
evidence properties in snapshot-scoped proposals. It is a different path, not
a repair of the native OpenLineage converter, and its server persistence remains
unverified.

## Verified result (2026-11-17)

Node 24.22.1 and JDK 21.0.13 ran the pinned release against Gateway exporter
sources matching public `v0.3.0-preview.1`. The final behavior-characterization
run passed **19/19**, exit 0. The separate strict association gate passed
**16/19**, with **3 failures**, exit 1; no test was skipped. The existing exporter
suite passed 32/32 and the separate catalog/telemetry SDK suite passed 18/18.
Those suites are supporting regressions, not additional receiver tests.

| Observation | Consequence |
| --- | --- |
| Explicit `odap-gateway` orchestrator works; absent override is rejected for this producer | Configure the integration explicitly; this is not producer auto-discovery |
| Claim/observation timestamps and UUID instance identity survive | These remain historical Gateway times, not measured warehouse execution times |
| FAIL and ABORT both map to FAILURE; native values remain distinct | Consumers must inspect `nativeResultType` to preserve cancellation semantics |
| Parser retains `odap_evidence`; generated MCPs omit its digest and trust flags | All three strict digest-retention checks fail; native conversion alone is not an evidence archive |
| Omitted input/output datasets become explicit empty instance aspects | No dataset edges are invented, but unknown versus known-empty information is lost |
| Duplicate events generate duplicate proposal lists without message IDs | Converter repeatability does not establish ingestion deduplication |
| Reversed and terminal-only input still generates proposals | There is no lifecycle admission check in this conversion call; server behavior is untested |
| A same-run billing revision has a changed evidence digest but identical MCPs | Native proposals cannot distinguish those evidence snapshots; the separate SDK path uses snapshot identity |

The initial probe did not compile because its Jackson import assumed the wrong
shaded package. Its nonzero exit and 18 hook-failed test entries were retained;
no converter assertion ran in that attempt. The correction uses the artifact's
own `OpenLineageClientUtils.newObjectMapper()`. The successful earlier 18-case
run and strict three-failure run were also retained before adding the explicit
unknown/empty dataset check. Upstream code and acceptance assertions were not
weakened to turn the strict failure into a pass. These are author-run tests, not
maintainer approval or independent acceptance.
