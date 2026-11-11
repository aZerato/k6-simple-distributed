// Validation du script k6 avant envoi aux workers.
//
// Un script k6 ne peut importer que des modules k6 (k6, k6/metrics, k6/html,
// k6/crypto, k6/csv, k6/experimental/oracle) : tout import de module Node.js
// (fs, path, http, child_process...) fait planter k6 à l'initialisation
// (« The moduleSpecifier "fs" couldn't be recognised as something k6 supports »).
// On le détecte côté orchestrateur pour renvoyer une erreur claire avant
// d'envoyer le script aux workers.
const K6_NODE_BUILTIN_MODULES = ['fs/promises', 'fs/constants', 'fs', 'path/posix', 'path/win32', 'path', 'http2', 'http', 'https', 'os', 'child_process', 'crypto', 'net', 'stream', 'url', 'util', 'zlib', 'events', 'buffer', 'process', 'cluster', 'dgram', 'dns/promises', 'dns', 'readline', 'repl', 'inspector', 'perf_hooks', 'assert', 'async_hooks', 'console', 'diagnostics_channel', 'domain', 'module', 'punycode', 'querystring', 'string_decoder', 'timers', 'tty', 'v8', 'vm', 'worker_threads', 'sea', 'sqlite', 'trace_events', 'wasi'];
const K6_NODE_IMPORT_RE = new RegExp(`(?:require\\s*\\(\\s*|import\\s+(?:[^;\\n]*?\\s+from\\s+)?)(['"])(?:node:)?(${K6_NODE_BUILTIN_MODULES.join('|')})\\1`, 'i');

// Renvoie le nom du module Node.js importé (ou null si le script est propre)
export function findNodeBuiltinImport(script) {
  const m = K6_NODE_IMPORT_RE.exec(script || '');
  return m ? m[2] : null;
}
