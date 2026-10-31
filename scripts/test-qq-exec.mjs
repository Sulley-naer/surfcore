// qq_run_code（owner 受控命令执行）离线回归：策略校验纯逻辑 + 少量真实命令（只读/无害）。
import assert from 'node:assert/strict';
import { normalizeExecConfig, policyError, runCommand } from '../src/qq-exec.mjs';

// ── 1. 配置归一化 ───────────────────────────────────────────────────────────
{
  const cfg = normalizeExecConfig({});
  assert.equal(cfg.enabled, true, '默认开启');
  assert.equal(cfg.timeoutMs, 60000, '默认超时 60s');
  assert.equal(cfg.maxOutputChars, 8000, '默认输出 8000 字符');
  assert.equal(normalizeExecConfig({ enabled: false }).enabled, false, '可显式关闭');
  const clamped = normalizeExecConfig({ timeoutMs: 1, maxOutputChars: 1 });
  assert.equal(clamped.timeoutMs, 5000, 'timeoutMs 下限 5000');
  assert.equal(clamped.maxOutputChars, 200, 'maxOutputChars 下限 200');
  assert.equal(normalizeExecConfig({ timeoutMs: 99999999 }).timeoutMs, 300000, 'timeoutMs 上限 300000');
}

// ── 2. 策略：允许的只读命令 ─────────────────────────────────────────────────
{
  for (const ok of [
    'git status', 'git log --oneline', 'git diff', 'git show HEAD', 'git branch',
    'git rev-parse --abbrev-ref HEAD', 'git remote -v', 'git --version', 'git.exe status',
    'node -v', 'node --version', 'npm -v', 'pnpm -v',
    'ls', 'ls -la', 'dir', 'cat README.md', 'type README.md', 'more README.md',
    'grep -r foo .', 'rg todo', 'find . -name "*.js"', 'where git', 'which git',
    'echo hello', 'pwd',
  ]) {
    assert.equal(policyError(ok), null, `应放行：${ok}`);
  }
}

// ── 3. 策略：拒绝 ───────────────────────────────────────────────────────────
{
  // 空 / 过长
  assert.match(policyError(''), /不能为空/);
  assert.match(policyError('   '), /不能为空/);
  assert.match(policyError('echo ' + 'a'.repeat(600)), /过长/);

  // shell 元字符 / 拼接 / 重定向 / 变量展开 / 转义
  for (const bad of [
    'git status; git push', 'echo a | grep a', 'cat x > y', 'cat x < y',
    'git log && git push', 'echo `whoami`', 'echo $(whoami)', 'echo %PATH%', 'ec^ho hi',
    'echo a & echo b', 'echo (a)', 'echo a\nrm -rf .', 'echo a\r\nrm -rf .',
  ]) {
    assert.notEqual(policyError(bad), null, `应拒（元字符）：${JSON.stringify(bad)}`);
  }

  // 首词不在白名单
  for (const bad of ['rm -rf .', 'bash -c x', 'sh x', 'curl http://x', 'python -c "1"', 'powershell whoami', 'pwsh whoami', 'wget x']) {
    assert.match(policyError(bad), /不在白名单/, `应拒（首词）：${bad}`);
  }

  // git 写操作词
  for (const bad of ['git push', 'git commit -m x', 'git reset --hard', 'git add .', 'git checkout main', 'git merge x', 'git clone x', 'git clean -fd']) {
    assert.notEqual(policyError(bad), null, `应拒（git 写）：${bad}`);
  }
  assert.notEqual(policyError('git log --output=/tmp/x'), null, '应拒（git --output 写文件）');

  // 执行任意代码类
  assert.notEqual(policyError('node -e "console.log(1)"'), null, '应拒（node -e 任意执行）');
  assert.notEqual(policyError('node some.js'), null, '应拒（node 跑脚本）');
  assert.notEqual(policyError('npm install x'), null, '应拒（npm install）');
  assert.notEqual(policyError('npm run build'), null, '应拒（npm run 任意脚本）');
  assert.notEqual(policyError('find . -exec rm {} \\;'), null, '应拒（find -exec）');
  assert.notEqual(policyError('find . -delete'), null, '应拒（find -delete）');
}

// ── 4. runCommand：真实执行 + 脱敏 + 拒绝不 spawn ───────────────────────────
{
  const okEcho = await runCommand('echo hello-qq-exec', { cwd: process.cwd() });
  assert.equal(okEcho.ok, true, 'echo 应成功');
  assert.match(okEcho.output, /hello-qq-exec/, 'echo 输出应含文本');
  assert.equal(okEcho.error, null, 'echo 无 error');

  const okNode = await runCommand('node -v', {});
  assert.equal(okNode.ok, true, 'node -v 应成功');
  assert.match(okNode.output, /v\d+\.\d+\.\d+/, 'node -v 应输出版本号');

  // 被拒命令：不应 spawn，直接返回拒绝原因
  const rejected = await runCommand('git push', {});
  assert.equal(rejected.ok, false, 'git push 应被拒');
  assert.match(rejected.error, /危险词|不在白名单|元字符|参数不允许/, '拒绝原因应命中策略');

  // 根路径脱敏
  const masked = await runCommand('echo D:/surfcore/repo', { maskRoot: 'D:/surfcore/repo' });
  assert.equal(masked.ok, true, 'echo 应成功');
  assert.ok(!masked.output.includes('D:/surfcore/repo'), '输出不应含被脱敏的绝对路径');
  assert.ok(masked.output.includes('.'), '脱敏后应出现相对占位 .');
}

console.log('✅ test-qq-exec 通过');
