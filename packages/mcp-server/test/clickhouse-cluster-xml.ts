// Verify the cluster config snippet we mount into the container is
// well-formed XML, substitutes user-provided cluster name / shard / replica
// correctly, escapes hostile input, and contains the four sections the
// project actually relies on (keeper_server, zookeeper, remote_servers,
// macros). Pure-logic test — no container required.
import { buildClusterConfigXml, escapeXmlText } from '../src/core/clickhouse.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`CLICKHOUSE CLUSTER XML FAIL: ${msg}`);
}

function main() {
  // ── 1. Default-shape snippet ───────────────────────────────────────────
  const xml = buildClusterConfigXml({ name: 'default', shard: '01', replica: 'r1' });
  assert(xml.includes('<keeper_server>'), 'snippet must enable embedded Keeper');
  assert(xml.includes('<tcp_port>9181</tcp_port>'), 'Keeper TCP port 9181');
  assert(xml.includes('<zookeeper>') && xml.includes('<port>9181</port>'), 'CH must point at its own embedded Keeper');
  assert(xml.includes('<remote_servers>') && xml.includes('<default>') && xml.includes('</default>'),
    'remote_servers must define the named cluster');
  assert(/<internal_replication>true<\/internal_replication>/.test(xml), 'shard internal_replication=true');
  assert(xml.includes('<host>localhost</host>'), 'replica host points at self');
  assert(xml.includes('<port>9000</port>'), 'replica uses ClickHouse native TCP port 9000');
  assert(xml.includes('<macros>') && /<cluster>default<\/cluster>/.test(xml), 'macros include {cluster}');
  assert(/<shard>01<\/shard>/.test(xml), 'macros include {shard}=01');
  assert(/<replica>r1<\/replica>/.test(xml), 'macros include {replica}=r1');
  console.log('  ✓ default cluster XML has all four required sections + macros');

  // ── 2. Custom name / shard / replica substitute correctly ──────────────
  const custom = buildClusterConfigXml({ name: 'analytics_cluster', shard: 'shard-A', replica: 'replica-3' });
  assert(custom.includes('<analytics_cluster>') && custom.includes('</analytics_cluster>'),
    'custom cluster name becomes XML tag');
  assert(/<shard>shard-A<\/shard>/.test(custom), 'custom shard value');
  assert(/<replica>replica-3<\/replica>/.test(custom), 'custom replica value');
  assert(/<cluster>analytics_cluster<\/cluster>/.test(custom), 'macros mirror the cluster name');
  console.log('  ✓ custom cluster name + shard + replica substituted');

  // ── 3. XML-escape user-controlled text content ─────────────────────────
  // Cluster names go through the schema's identifier regex upstream, but the
  // helper still escapes defensively — shard/replica accept arbitrary text.
  assert(escapeXmlText('<&>"\'') === '&lt;&amp;&gt;&quot;&apos;', 'XML escape covers all 5 entities');
  const escaped = buildClusterConfigXml({
    name: 'safe_cluster',
    shard: 'shard&<bad>',
    replica: 'r"1\'',
  });
  assert(escaped.includes('shard&amp;&lt;bad&gt;'), 'shard text escaped');
  assert(escaped.includes('r&quot;1&apos;'), 'replica text escaped');
  // The dangerous chars must NOT appear unescaped anywhere they'd break the XML
  assert(!/<shard>shard&<bad><\/shard>/.test(escaped), 'no raw < or & in shard tag');
  console.log('  ✓ shard/replica text gets XML-escaped (defensive)');

  // ── 4. Document the assumed contract: keeper + zookeeper share port ────
  // The synthetic single-node setup works precisely because the CH server
  // talks to "itself" via the in-container loopback. If we ever split Keeper
  // into its own container, this test reminds us to revisit zookeeper host.
  const kp = xml.match(/<keeper_server>[\s\S]*?<\/keeper_server>/)![0];
  const zk = xml.match(/<zookeeper>[\s\S]*?<\/zookeeper>/)![0];
  assert(kp.includes('<tcp_port>9181</tcp_port>') && zk.includes('<port>9181</port>'),
    'keeper_server and zookeeper sections agree on port 9181');
  assert(zk.includes('<host>localhost</host>'), 'zookeeper points at localhost');
  console.log('  ✓ Keeper TCP port matches the <zookeeper> client port');

  console.log('clickhouse-cluster-xml: ALL PASS');
}

main();
