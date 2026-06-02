'use strict';
const M=require('../ClaudeCommandTriggerMatcher');
const m=new M();
let fails=0;
function assert(name, cond, details){ if(!cond){ fails++; console.log('FAIL', name, details||''); } else console.log('PASS', name); }
function match(tool, command, regex){ return m.matches(tool,{command},regex); }
const BG=/^Bash.*\bgcloud\b/;
const BGR=/^Bash.*\bgcloud\b.*\brun\b/;
const PG=/^PowerShell.*\bgcloud\b/;
// 1/2 surface raw/normalized
let s=m.extractExecutionSurfaces('Bash',{command:'/usr/bin/gcloud.exe run deploy'}).find(x=>x.normalizedCommand==='gcloud');
assert('raw normalized separate', s && s.command==='/usr/bin/gcloud.exe' && s.normalizedCommand==='gcloud', s);
// 3 regex lastIndex
const re=/gcloud/g; re.lastIndex=3; m.matches('Bash',{command:'gcloud run'},re); assert('regex lastIndex preserved', re.lastIndex===3, re.lastIndex);
// 10 backtick nested/escaped
assert('escaped backtick outer', match('Bash','echo `gcloud run deploy \`gcloud auth list\` outer`',BGR));
// 11 powershell backtick quote should not swallow command after
assert('ps backtick escape quote', match('PowerShell','Write-Host "say `"hi`""; gcloud run deploy',/^PowerShell.*\bgcloud\b.*run/));
// 12 paren pipe not split weird + command after
assert('ps paren depth', match('PowerShell','(Write-Host a | Write-Host b); gcloud run deploy',/^PowerShell.*\bgcloud\b.*run/));
// 14 prefix
assert('pwsh -Co', match('PowerShell',"pwsh -Co 'gcloud run deploy'",/^PowerShell.*\bgcloud\b.*run/));
assert('pwsh -Fi script known', match('PowerShell',"Set-Content -Path .\\d.ps1 -Value 'gcloud run deploy'; pwsh -Fi .\\d.ps1",/^PowerShell.*\bgcloud\b.*run/));
// 17 docker common flags
assert('docker mount', match('Bash','docker run --mount type=bind,src=/h,dst=/c image gcloud run deploy',BGR));
// 18 ssh options
assert('ssh option', match('Bash',"ssh -J jump -o StrictHostKeyChecking=no host 'gcloud run deploy'",BGR));
// 19 aws commands multiple/JSON
assert('aws json commands', match('Bash',`aws ssm send-command --parameters '{"commands":["echo ok","gcloud run deploy"]}'`,BGR));
assert('aws shorthand commands', match('Bash',`aws ssm send-command --parameters commands="echo ok,gcloud run deploy"`,BGR));
// 20 xargs long
assert('xargs max args', match('Bash','xargs --max-args 1 gcloud run deploy',BGR));
// 23 mcp cmd should parse cmd
assert('mcp cmd', m.matches('mcp__x__y',{cmd:'gcloud run deploy', shell:'cmd'}, /^mcp__x__y.*\bgcloud\b.*run/));
assert('mcp fish opaque no gcloud', !m.matches('mcp__x__y',{cmd:'gcloud run deploy', shell:'fish'}, /^mcp__x__y.*\bgcloud\b/));
// 24 .com
assert('normalize .com', match('Bash','gcloud.com run deploy',BGR));
// 26 compatibility argv with executable mention
assert('compat json args', match('Bash','gcloud run deploy --project=prod', /^Bash\{"command":"gcloud.*--project=prod"\}/));
// 27 inline writes
assert('tee here string script', match('Bash',"tee /tmp/d.sh <<<'gcloud run deploy'\nbash /tmp/d.sh",BGR));
assert('cp known script', match('Bash',"echo 'gcloud run deploy' > a.sh\ncp a.sh b.sh\nbash b.sh",BGR));
// 28 multiple hdocs should not swallow later command
assert('multiple heredocs no swallow later', match('Bash','cat <<A <<B\ndataA\nA\ndataB\nB\ngcloud run deploy',BGR));
// 32 &> target
assert('&> heredoc target', match('Bash','cat &> /tmp/d.sh <<EOF\ngcloud run deploy\nEOF\nbash /tmp/d.sh',BGR));
// 35 ps array value
assert('ps value array script', match('PowerShell',"Set-Content -Path .\\d.ps1 -Value 'gcloud','run','deploy'; & .\\d.ps1",/^PowerShell.*\bgcloud\b.*run/));
console.log('fails', fails);
process.exit(fails?1:0);
