'use strict';
const Matcher = require('../ClaudeCommandTriggerMatcher');
const m = new Matcher();
function test(name, tool, command, regex, expected) {
  const got = m.matches(tool, {command}, regex);
  const status = got === expected ? 'PASS' : 'FAIL';
  console.log(`${status} ${name}: got=${got} expected=${expected}`);
  if (got !== expected) {
    console.log(m.lastSurfaces.map(s => ({cmd:s.command,norm:s.normalizedCommand,line:s.commandLine,raw:s.rawCommandLine,source:s.source,opaque:s.opaque})))
  }
}
const g=/^Bash.*\bgcloud\b/;
const gr=/^Bash.*\bgcloud\b.*\brun\b/;
test('known false positive echo json pipe node', 'Bash', `echo '{"hook_event_name":"PreToolUse","tool_input":{"command":"gcloud run deploy api-prd --project=my-project --image=x"}}' | node .claude/hooks/router.js PreToolUse`, g, false);
test('direct gcloud', 'Bash', 'gcloud run deploy', gr, true);
test('path gcloud', 'Bash', '/usr/bin/gcloud run deploy', /^Bash.*\/usr\/bin\/gcloud\b.*run/, true);
test('gcloud exe', 'Bash', 'gcloud.exe run deploy', /^Bash.*gcloud\.exe\b.*run/, true);
test('subshell', 'Bash', '(gcloud run deploy)', gr, true);
test('brace no whitespace', 'Bash', '{gcloud run deploy;}', gr, true);
test('function call', 'Bash', 'f() { gcloud run deploy; }; f', gr, true);
test('function definition no call', 'Bash', 'f() { gcloud run deploy; }', gr, false);
test('function keyword call', 'Bash', 'function deploy { gcloud run deploy; }; deploy', gr, true);
test('kubectl exec -i', 'Bash', 'kubectl exec -i pod gcloud run deploy', gr, true);
test('shell cache not c', 'Bash', 'sh -cache file', /^Bash.*\bfile\b/, false);
test('comment mid token no match', 'Bash', 'echo gcloud#run', gr, false);
test('quoted heredoc marker no strip', 'Bash', 'echo "<<EOF"\ngcloud run deploy\nEOF', gr, true);
test('comment heredoc marker no strip', 'Bash', '# <<EOF\ngcloud run deploy\nEOF', gr, true);
test('real heredoc data no match', 'Bash', 'cat <<EOF\ngcloud run deploy\nEOF', gr, false);
test('heredoc script then bash', 'Bash', 'cat > /tmp/deploy.sh <<EOF\ngcloud run deploy\nEOF\nbash /tmp/deploy.sh', gr, true);
test('redirect 2>&1 command', 'Bash', '2>&1 gcloud run deploy', gr, true);
test('docker run volume', 'Bash', 'docker run --rm -v /h:/c image gcloud run deploy', gr, true);
test('xargs -n', 'Bash', 'xargs -n 1 gcloud run deploy', gr, true);
test('alias', 'Bash', "alias gc='gcloud'; gc run deploy", gr, true);
test('powershell start process filepath', 'PowerShell', "Start-Process -FilePath gcloud -ArgumentList 'run deploy'", /^PowerShell.*\bgcloud\b.*\brun\b/, true);
test('powershell scriptblock call', 'PowerShell', '& { gcloud run deploy }', /^PowerShell.*\bgcloud\b.*\brun\b/, true);
test('powershell foreach percent', 'PowerShell', '1..3 | %{ gcloud run deploy }', /^PowerShell.*\bgcloud\b.*\brun\b/, true);
test('powershell foreach statement', 'PowerShell', 'foreach ($x in $items) { gcloud run deploy }', /^PowerShell.*\bgcloud\b.*\brun\b/, true);
test('powershell windows path', 'PowerShell', '& "C:\\tools\\gcloud.exe" run deploy', /^PowerShell.*\bgcloud\b.*\brun\b/, true);
// encoded command
const enc = Buffer.from('gcloud run deploy', 'utf16le').toString('base64');
test('powershell encoded', 'PowerShell', `pwsh -EncodedCommand ${enc}`, /^PowerShell.*\bgcloud\b.*\brun\b/, true);
