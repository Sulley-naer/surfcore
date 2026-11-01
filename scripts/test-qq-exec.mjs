// qq_run_code（owner 受控命令执行）离线回归：策略校验纯逻辑 + 少量真实命令（只读/无害）。
// 两种模式都测：blacklist（默认，放行任意命令只拦破坏性）与 whitelist（保守回退）。
import assert from 'node:assert/strict';
import { normalizeExecConfig, policyError, runCommand } from '../src/qq-exec.mjs';

// ── 1. 配置归一化 ───────────────────────────────────────────────────────────
{
  const cfg = normalizeExecConfig({});
  assert.equal(cfg.enabled, true, '默认开启');
  assert.equal(cfg.mode, 'blacklist', '默认黑名单模式');
  assert.equal(cfg.timeoutMs, 60000, '默认超时 60s');
  assert.equal(cfg.maxOutputChars, 8000, '默认输出 8000 字符');
  assert.equal(normalizeExecConfig({ enabled: false }).enabled, false, '可显式关闭');
  assert.equal(normalizeExecConfig({ mode: 'whitelist' }).mode, 'whitelist', '可切回白名单');
  assert.equal(normalizeExecConfig({ mode: 'bogus' }).mode, 'blacklist', '非法 mode 回退黑名单');
  const clamped = normalizeExecConfig({ timeoutMs: 1, maxOutputChars: 1 });
  assert.equal(clamped.timeoutMs, 5000, 'timeoutMs 下限 5000');
  assert.equal(clamped.maxOutputChars, 200, 'maxOutputChars 下限 200');
  assert.equal(normalizeExecConfig({ timeoutMs: 99999999 }).timeoutMs, 300000, 'timeoutMs 上限 300000');
}

// ── 2. 白名单模式：放行只读命令 ─────────────────────────────────────────────
{
  for (const ok of [
    'git status', 'git log --oneline', 'git diff', 'git show HEAD', 'git branch',
    'git rev-parse --abbrev-ref HEAD', 'git remote -v', 'git --version', 'git.exe status',
    'node -v', 'node --version', 'npm -v', 'pnpm -v',
    'ls', 'ls -la', 'dir', 'cat README.md', 'type README.md', 'more README.md',
    'grep -r foo .', 'rg todo', 'find . -name "*.js"', 'where git', 'which git',
    'echo hello', 'pwd',
  ]) {
    assert.equal(policyError(ok, { mode: 'whitelist' }), null, `白名单应放行：${ok}`);
  }
}

// ── 3. 白名单模式：拒绝 ─────────────────────────────────────────────────────
{
  assert.match(policyError('', { mode: 'whitelist' }), /不能为空/);
  assert.match(policyError('   ', { mode: 'whitelist' }), /不能为空/);
  assert.match(policyError('echo ' + 'a'.repeat(600), { mode: 'whitelist' }), /过长/);

  // shell 元字符 / 拼接 / 重定向 / 变量展开 / 转义
  for (const bad of [
    'git status; git push', 'echo a | grep a', 'cat x > y', 'cat x < y',
    'git log && git push', 'echo `whoami`', 'echo $(whoami)', 'echo %PATH%', 'ec^ho hi',
    'echo a & echo b', 'echo (a)', 'echo a\nrm -rf .', 'echo a\r\nrm -rf .',
  ]) {
    assert.notEqual(policyError(bad, { mode: 'whitelist' }), null, `白名单应拒（元字符）：${JSON.stringify(bad)}`);
  }

  // 首词不在白名单
  for (const bad of ['rm -rf .', 'bash -c x', 'sh x', 'curl http://x', 'python -c "1"', 'powershell whoami', 'pwsh whoami', 'wget x']) {
    assert.match(policyError(bad, { mode: 'whitelist' }), /不在白名单/, `白名单应拒（首词）：${bad}`);
  }

  // git 写操作词
  for (const bad of ['git push', 'git commit -m x', 'git reset --hard', 'git add .', 'git checkout main', 'git merge x', 'git clone x', 'git clean -fd']) {
    assert.notEqual(policyError(bad, { mode: 'whitelist' }), null, `白名单应拒（git 写）：${bad}`);
  }
  assert.notEqual(policyError('git log --output=/tmp/x', { mode: 'whitelist' }), null, '白名单应拒（git --output 写文件）');

  // 执行任意代码类
  assert.notEqual(policyError('node -e "console.log(1)"', { mode: 'whitelist' }), null, '白名单应拒（node -e）');
  assert.notEqual(policyError('node some.js', { mode: 'whitelist' }), null, '白名单应拒（node 跑脚本）');
  assert.notEqual(policyError('npm install x', { mode: 'whitelist' }), null, '白名单应拒（npm install）');
  assert.notEqual(policyError('npm run build', { mode: 'whitelist' }), null, '白名单应拒（npm run）');
  assert.notEqual(policyError('find . -exec rm {} \\;', { mode: 'whitelist' }), null, '白名单应拒（find -exec）');
  assert.notEqual(policyError('find . -delete', { mode: 'whitelist' }), null, '白名单应拒（find -delete）');
}

// ── 4. 黑名单模式：默认放行任意命令（含拼接/重定向/单文件删除）────────────
{
  for (const ok of [
    'git push', 'git commit -m x', 'git reset --hard', 'git checkout main',
    'node -e "console.log(1)"', 'node some.js', 'npm install x', 'npm run build',
    'curl http://example.com', 'python -c "print(1)"', 'powershell whoami', 'pwsh whoami',
    'wget http://x', 'bash -c "echo hi"', 'pip install requests', 'go build',
    // 拼接 / 重定向 / 后台（终端常见能力）
    'git status && git log', 'echo a | findstr a', 'echo hi > out.txt', 'cat x < y',
    'echo a & echo b', 'git status; git branch',
    // 单文件删除（不带递归/强制参数）——常规清理放行
    'del temp.txt', 'erase temp.txt', 'rm temp.txt', 'rd empty-dir', 'echo (a)',
  ]) {
    assert.equal(policyError(ok, { mode: 'blacklist' }), null, `黑名单应放行：${ok}`);
  }
}

// ── 5. 黑名单模式：拦截破坏性指令 ──────────────────────────────────────────
{
  for (const bad of [
    // 递归/静默/强制删除
    'del /s /q C:\\temp\\*', 'del /f /q x.txt', 'erase /s /f /q *', 'rd /s /q build',
    'rmdir /s node_modules', 'rm -rf /', 'rm -fr .', 'rm -r build', 'rm -f x',
    'rm --recursive dir', 'rm --force x', 'deltree /y build',
    // 格式化 / 磁盘 / 分区
    'format C:', 'format D: /q', 'mkfs.ext4 /dev/sda', 'diskpart', 'dd if=/dev/zero of=/dev/sda',
    'mountvol D: /d',
    // 关机 / 重启
    'shutdown /s /t 0', 'shutdown /r /f', 'reboot', 'halt', 'poweroff', 'logoff', 'init 6',
    // 引导 / 文件系统
    'bcdedit /set {default} testsigning on', 'fsutil behavior set disable8dot3 1',
    // ACL / 所有权 / 权限
    'icacls state /grant Everyone:F', 'takeown /f C:\\Windows', 'chmod -R 777 /', 'chown -R root /',
    // 注册表
    'reg delete HKCU\\Software\\x /f', 'reg add HKCU\\Software\\x /v a /t REG_SZ /d 1',
    // 杀进程
    'taskkill /f /im explorer.exe', 'taskkill /pid 1234 /f', 'killall chrome', 'pkill -9 node', 'kill 1234',
    // 服务 / 账户 / 网络
    'sc stop wuauserv', 'sc delete mysvc', 'net user admin pass123', 'net stop spooler',
    'net share myshare=C:\\x', 'netsh interface set interface eth0 disable',
    // 磁盘覆写 / 镜像
    'cipher /w:C:\\', 'robocopy src dst /mir',
  ]) {
    assert.match(policyError(bad, { mode: 'blacklist' }), /破坏性指令黑名单/, `黑名单应拦：${bad}`);
  }
}

// ── 6. 黑名单模式：拦截高危元字符（命令替换/变量/转义）────────────────────
{
  for (const bad of [
    'echo `whoami`', 'echo $(whoami)', 'echo %PATH%', 'ec^ho hi',
    'echo a\nrm -rf .', 'echo a\r\nrm -rf .',
  ]) {
    assert.match(policyError(bad, { mode: 'blacklist' }), /元字符/, `黑名单应拦（元字符）：${JSON.stringify(bad)}`);
  }
  // fork bomb（即使绕过元字符，也命中黑名单）
  assert.match(policyError(':(){ :|:& };:', { mode: 'blacklist' }), /破坏性指令黑名单|元字符/, 'fork bomb 应被拦');
}

// ── 7. runCommand：真实执行 + 脱敏 + 拒绝不 spawn ───────────────────────────
{
  const okEcho = await runCommand('echo hello-qq-exec', { cwd: process.cwd() });
  assert.equal(okEcho.ok, true, 'echo 应成功');
  assert.match(okEcho.output, /hello-qq-exec/, 'echo 输出应含文本');
  assert.equal(okEcho.error, null, 'echo 无 error');

  const okNode = await runCommand('node -v', {});
  assert.equal(okNode.ok, true, 'node -v 应成功');
  assert.match(okNode.output, /v\d+\.\d+\.\d+/, 'node -v 应输出版本号');

  // 黑名单模式：破坏性命令被拒，不 spawn
  const rejected = await runCommand('rm -rf /', {});
  assert.equal(rejected.ok, false, 'rm -rf 应被拒');
  assert.match(rejected.error, /破坏性指令黑名单/, '拒绝原因应命中黑名单');

  // 白名单模式：git push 被拒（保守回退仍生效）
  const rejectedWl = await runCommand('git push', { mode: 'whitelist' });
  assert.equal(rejectedWl.ok, false, 'whitelist 模式 git push 应被拒');
  assert.match(rejectedWl.error, /危险词|不在白名单|元字符|参数不允许/, '白名单拒绝原因应命中策略');

  // maskRoot 脱敏仍可用
  const masked = await runCommand('echo D:/surfcore/repo', { maskRoot: 'D:/surfcore/repo' });
  assert.equal(masked.ok, true, 'echo 应成功');
  assert.ok(!masked.output.includes('D:/surfcore/repo'), '输出不应含被脱敏的绝对路径');
  assert.ok(masked.output.includes('.'), '脱敏后应出现相对占位 .');
}

// ── 8. 搜索类命令「未命中」不算失败（findstr/grep 退出码 1 是正常语义）────
{
  // 通过管道喂 stdin，不依赖文件是否存在：没匹配 → findstr 退出码 1 + stderr 为空。
  const miss = await runCommand('echo hello | findstr /c:"__qq_exec_no_such_token__"', { cwd: process.cwd() });
  assert.equal(miss.code, 1, 'findstr 未命中退出码应为 1');
  assert.equal(miss.ok, true, '搜索未命中应视为成功（不是失败）');
  assert.equal(miss.error, null, '搜索未命中不应产生 error');
  assert.match(miss.output, /没有匹配到内容/, 'output 应说明未匹配、不要重试');

  // 对照：真正不存在的命令仍是失败，并带可读原因（不会被未命中语义吞掉）。
  const bad = await runCommand('__qq_exec_no_such_command__', { cwd: process.cwd() });
  assert.equal(bad.ok, false, '不存在的命令应失败');
  assert.match(bad.error, /退出码/, '应给出可读错误原因');
}

console.log('✅ test-qq-exec 通过');
