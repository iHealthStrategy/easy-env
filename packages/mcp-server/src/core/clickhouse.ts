// Thin HTTP client helpers for ClickHouse. easy-env doesn't pull in the
// official @clickhouse/client driver — every operation we need is a single
// POST with a query in the body, so node:fetch is enough and keeps the
// dependency surface small.

/** Backtick-quote a ClickHouse identifier (database/table/column). Escapes
 *  embedded backticks. Use this for anything we splice into a query. */
export function escapeClickhouseIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

/** Escape XML text content (used when interpolating user-provided cluster
 *  name / shard / replica into the config snippet). Does NOT cover all of
 *  XML 1.0 — caller is responsible for ensuring identifiers used as tag
 *  names already match `[A-Za-z_][A-Za-z0-9_]*`. */
export function escapeXmlText(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!),
  );
}

export interface ClickhouseClusterConfig {
  /** Cluster name — also used as the XML tag inside <remote_servers>, so
   *  it must already be a valid XML identifier (callers must validate). */
  name: string;
  shard: string;
  replica: string;
}

/**
 * Build the XML config snippet we mount into the container at
 * /etc/clickhouse-server/config.d/easy-env-cluster.xml to enable:
 *   - embedded ClickHouse Keeper on tcp_port 9181 (raft on 9234)
 *   - <zookeeper> pointing at the same node (so ReplicatedMergeTree works)
 *   - a synthetic <remote_servers> entry naming a single-shard /
 *     single-replica cluster, with both pointing at localhost:9000 (so
 *     Distributed table engine, ON CLUSTER DDL, and cluster() / remote()
 *     table functions all resolve correctly against the one container)
 *   - <macros> for {cluster}/{shard}/{replica} substitution in the
 *     ReplicatedMergeTree zookeeper-path template
 *
 * Storage lives under /var/lib/clickhouse/coordination (which is already
 * tmpfs-mounted in spawnClickhouse), so Keeper state is ephemeral — fine
 * for tests.
 *
 * Ports 9181 (Keeper) and 9234 (Keeper raft) stay container-internal — we
 * never expose them to the host. The project talks to ClickHouse via HTTP
 * 8123, which is the only port we map.
 */
export function buildClusterConfigXml(opts: ClickhouseClusterConfig): string {
  const cluster = escapeXmlText(opts.name);
  // shard/replica end up as text content inside <macros>; identifier-style
  // restrictions don't apply but XML-escape is still required.
  const shard = escapeXmlText(opts.shard);
  const replica = escapeXmlText(opts.replica);
  return `<clickhouse>
  <keeper_server>
    <tcp_port>9181</tcp_port>
    <server_id>1</server_id>
    <log_storage_path>/var/lib/clickhouse/coordination/log</log_storage_path>
    <snapshot_storage_path>/var/lib/clickhouse/coordination/snapshots</snapshot_storage_path>
    <coordination_settings>
      <operation_timeout_ms>10000</operation_timeout_ms>
      <session_timeout_ms>30000</session_timeout_ms>
    </coordination_settings>
    <raft_configuration>
      <server>
        <id>1</id>
        <hostname>localhost</hostname>
        <port>9234</port>
      </server>
    </raft_configuration>
  </keeper_server>
  <zookeeper>
    <node>
      <host>localhost</host>
      <port>9181</port>
    </node>
  </zookeeper>
  <remote_servers>
    <${cluster}>
      <shard>
        <internal_replication>true</internal_replication>
        <replica>
          <host>localhost</host>
          <port>9000</port>
        </replica>
      </shard>
    </${cluster}>
  </remote_servers>
  <macros>
    <cluster>${cluster}</cluster>
    <shard>${shard}</shard>
    <replica>${replica}</replica>
  </macros>
</clickhouse>
`;
}

async function clickhousePost(
  baseUrl: string,
  body: string,
  searchParams?: Record<string, string>,
): Promise<Response> {
  const url = new URL(baseUrl);
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
  }
  return fetch(url.toString(), { method: 'POST', body });
}

/** Run a SELECT … FORMAT JSONEachRow and return each row as an object.
 *  Empty body (no rows) returns []. Throws on non-2xx responses. */
export async function clickhouseQueryRows(
  baseUrl: string,
  sql: string,
): Promise<Array<Record<string, unknown>>> {
  const res = await clickhousePost(baseUrl, sql);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`clickhouse query failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const text = await res.text();
  if (!text.trim()) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

/** Execute a non-SELECT statement (DDL, INSERT, TRUNCATE). */
export async function clickhouseExec(baseUrl: string, sql: string): Promise<void> {
  const res = await clickhousePost(baseUrl, sql);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`clickhouse exec failed: ${res.status} ${text.slice(0, 500)}`);
  }
}

/** INSERT rows into <database>.<table> using FORMAT JSONEachRow. Caller is
 *  responsible for ensuring the table exists with a compatible schema. */
export async function clickhouseInsertRows(
  baseUrl: string,
  database: string,
  table: string,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  const query = `INSERT INTO ${escapeClickhouseIdent(database)}.${escapeClickhouseIdent(table)} FORMAT JSONEachRow`;
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  const res = await clickhousePost(baseUrl, body, { query });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `clickhouse INSERT INTO ${database}.${table} failed: ${res.status} ${text.slice(0, 500)}`,
    );
  }
}

/** TRUNCATE TABLE <database>.<table>. Used by seed mode='replace'. */
export async function clickhouseTruncate(
  baseUrl: string,
  database: string,
  table: string,
): Promise<void> {
  await clickhouseExec(
    baseUrl,
    `TRUNCATE TABLE ${escapeClickhouseIdent(database)}.${escapeClickhouseIdent(table)}`,
  );
}
