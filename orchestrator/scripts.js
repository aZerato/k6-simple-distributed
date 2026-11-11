// Validates the k6 script before sending it to the workers.
//
// A k6 script can only import k6 modules (k6, k6/metrics, k6/html,
// k6/crypto, k6/csv, k6/experimental/oracle): any Node.js module import
// (fs, path, http, child_process...) crashes k6 at init time
// ("The moduleSpecifier "fs" couldn't be recognised as something k6 supports").
// We detect it on the orchestrator side to return a clear error before
// sending the script to the workers.
const K6_NODE_BUILTIN_MODULES = ['fs/promises', 'fs/constants', 'fs', 'path/posix', 'path/win32', 'path', 'http2', 'http', 'https', 'os', 'child_process', 'crypto', 'net', 'stream', 'url', 'util', 'zlib', 'events', 'buffer', 'process', 'cluster', 'dgram', 'dns/promises', 'dns', 'readline', 'repl', 'inspector', 'perf_hooks', 'assert', 'async_hooks', 'console', 'diagnostics_channel', 'domain', 'module', 'punycode', 'querystring', 'string_decoder', 'timers', 'tty', 'v8', 'vm', 'worker_threads', 'sea', 'sqlite', 'trace_events', 'wasi'];
const K6_NODE_IMPORT_RE = new RegExp(`(?:require\\s*\\(\\s*|import\\s+(?:[^;\\n]*?\\s+from\\s+)?)(['"])(?:node:)?(${K6_NODE_BUILTIN_MODULES.join('|')})\\1`, 'i');

// Returns the name of the imported Node.js module (or null if the script is clean)
export function findNodeBuiltinImport(script) {
  const m = K6_NODE_IMPORT_RE.exec(script || '');
  return m ? m[2] : null;
}