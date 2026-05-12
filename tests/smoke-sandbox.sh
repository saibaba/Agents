#!/bin/bash
# Smoke test for sandbox-server.ts (10 tests)
# Usage: ./tests/smoke-sandbox.sh

set -e
cd "$(dirname "$0")/.."

# Kill any existing server on port 3000
lsof -ti:3000 | xargs kill -9 2>/dev/null || true

# Start sandbox server
node --experimental-strip-types src/sandbox-server.ts &
SERVER_PID=$!
sleep 3

PASS=0
FAIL=0

run_test() {
  local name="$1" code="$2" expect="$3"
  local result
  result=$(curl -s -X POST http://localhost:3000/execute \
    -H 'Content-Type: application/json' \
    -d "{\"code\": $(echo "$code" | jq -Rs .)}")

  if echo "$result" | grep -q "$expect"; then
    echo "✅ $name"
    PASS=$((PASS + 1))
  else
    echo "❌ $name"
    echo "   Expected to contain: $expect"
    echo "   Got: $result"
    FAIL=$((FAIL + 1))
  fi
}

echo "--- Sandbox Smoke Tests ---"
echo ""

run_test "Valid TypeScript" \
  'const nums: number[] = [1,2,3]; log("sum: " + nums.reduce((a,b) => a+b, 0)); finalAnswer(6);' \
  '"finalAnswer":true'

run_test "Type error caught" \
  'const x: number = "hello"; log(x);' \
  '"Type errors'

run_test "Plain JS still works" \
  'const x = 42; log("answer: " + x); finalAnswer(x);' \
  '"result":42'

run_test "log() output captured" \
  'log("hello"); log("world");' \
  '"output":\["hello","world"\]'

run_test "Runtime error caught" \
  'throw new Error("boom");' \
  '"success":false'

run_test "webSearch available" \
  'const t = typeof webSearch; log(t); finalAnswer(t);' \
  '"result":"function"'

run_test "readFile reads a file" \
  'const content: string = readFile("package.json"); log(content.substring(0, 20)); finalAnswer("ok");' \
  '"finalAnswer":true'

run_test "readFile error on missing file" \
  'const content: string = readFile("/nonexistent/file.txt"); log(content);' \
  '"success":false'

run_test "writeFile creates a file" \
  'const r: string = writeFile("/tmp/sandbox-test.txt", "hello sandbox"); log(r); finalAnswer(r);' \
  '"result":"ok"'

run_test "readFile reads back written file" \
  'const content: string = readFile("/tmp/sandbox-test.txt"); log(content); finalAnswer(content);' \
  '"result":"hello sandbox"'

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

# Cleanup
kill $SERVER_PID 2>/dev/null
wait $SERVER_PID 2>/dev/null || true

[ $FAIL -eq 0 ] && exit 0 || exit 1
