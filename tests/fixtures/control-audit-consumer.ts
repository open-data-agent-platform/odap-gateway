import { deliverNextControlEvent } from "../../lib/control-audit-delivery";
import { jobDatabase, jobSqlite } from "./job-sqlite";

const [source, sink, mode] = process.argv.slice(2);
void deliverNextControlEvent({db:jobDatabase(() => source),tenantId:"a",principalId:"owner"},"archive",async event => {
  const result = await jobSqlite(sink,"run",`INSERT INTO accepted(tenant,consumer,seq,payload,attempts) VALUES(?,?,?,?,1)
    ON CONFLICT(tenant,consumer,seq) DO UPDATE SET attempts=attempts+1 WHERE payload=excluded.payload`,
  [event.tenantId,event.consumerId,event.sequence,JSON.stringify(event)]);
  if (result.meta.changes !== 1) throw new Error("Fixture sink rejected changed payload");
  if (mode === "crash") process.exit(73); // The sink transaction committed; the source cursor has not.
  return event;
}).then(state => process.stdout.write(state));
