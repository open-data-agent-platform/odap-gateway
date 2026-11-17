import com.linkedin.data.codec.JacksonDataCodec;
import io.acryl.shaded.io.datahubproject.openlineage.config.DatahubOpenlineageConfig;
import io.acryl.shaded.io.datahubproject.openlineage.converter.OpenLineageToDataHub;
import io.acryl.shaded.io.openlineage.client.OpenLineageClientUtils;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.Permission;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;

/** Calls the converter shipped in the pinned official jar, never an emitter or Spark. */
public final class ReceiverProbe {
  private static int networkAttempts;

  @SuppressWarnings("removal")
  public static void main(String[] args) throws Exception {
    var json = OpenLineageClientUtils.newObjectMapper();
    var manifest = json.readTree(Files.readString(Path.of(args[0])));
    var codec = new JacksonDataCodec();
    // JDK 21 test-only tripwire; not a production sandbox or authentication control.
    System.setSecurityManager(new SecurityManager() {
      @Override public void checkPermission(Permission permission) {}
      @Override public void checkConnect(String host, int port) {
        networkAttempts++;
        throw new SecurityException("Network forbidden in converter probe");
      }
      @Override public void checkListen(int port) {
        networkAttempts++;
        throw new SecurityException("Listeners forbidden in converter probe");
      }
    });
    boolean guardVerified = false;
    try (var ignored = new Socket("127.0.0.1", 9)) {
      throw new IllegalStateException("Network tripwire failed");
    } catch (SecurityException expected) {
      guardVerified = networkAttempts > 0;
    }
    networkAttempts = 0;
    var cases = new ArrayList<Map<String, Object>>();
    for (var input : manifest.get("cases")) {
      var config = DatahubOpenlineageConfig.builder()
          .orchestrator(input.get("configured").asBoolean() ? "odap-gateway" : null)
          .build();
      var rows = new ArrayList<Map<String, Object>>();
      for (var wire : input.get("events")) {
        var row = new LinkedHashMap<String, Object>();
        try {
          var event = OpenLineageClientUtils.runEventFromJson(wire.toString());
          row.put("decoded", json.readTree(OpenLineageClientUtils.toJson(event)));
          var job = OpenLineageToDataHub.convertRunEventToJob(event, config);
          var proposals = job.toMcps(config);
          row.put("flowUrn", job.getFlowUrn().toString());
          row.put("jobUrn", job.getJobUrn().toString());
          row.put("instanceUrn", job.getDataProcessInstanceUrn().toString());
          row.put("flowInfo", json.readTree(codec.mapToString(job.getDataFlowInfo().data())));
          row.put("jobInfo", json.readTree(codec.mapToString(job.getJobInfo().data())));
          row.put("properties", json.readTree(codec.mapToString(job.getDataProcessInstanceProperties().data())));
          row.put("runEvent", json.readTree(codec.mapToString(job.getDataProcessInstanceRunEvent().data())));
          var mcps = new ArrayList<Map<String, Object>>();
          for (var proposal : proposals) {
            var mcp = new LinkedHashMap<String, Object>();
            mcp.put("entityType", proposal.getEntityType());
            mcp.put("entityUrn", proposal.getEntityUrn().toString());
            mcp.put("aspectName", proposal.getAspectName());
            mcp.put("changeType", proposal.getChangeType().toString());
            mcp.put("aspect", json.readTree(new String(
                proposal.getAspect().getValue().copyBytes(), StandardCharsets.UTF_8)));
            mcps.add(mcp);
          }
          row.put("mcps", mcps);
        } catch (Exception exception) {
          row.put("errorClass", exception.getClass().getName());
          row.put("error", exception.getMessage());
        }
        rows.add(row);
      }
      cases.add(Map.of("name", input.get("name").asText(), "rows", rows));
    }
    var result = Map.of(
        "javaVersion", System.getProperty("java.version"),
        "guardVerified", guardVerified,
        "networkAttempts", networkAttempts,
        "cases", cases);
    Files.writeString(Path.of(args[1]), json.writerWithDefaultPrettyPrinter().writeValueAsString(result));
    if (!guardVerified || networkAttempts != 0) throw new IllegalStateException("Network isolation check failed");
  }
}
