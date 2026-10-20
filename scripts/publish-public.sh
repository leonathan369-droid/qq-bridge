#!/usr/bin/env bash
# 把当前仓库发布到公开 GitHub 仓库（维护者用）。
#
# 为什么需要脚本：公开仓库不能带维护者的本机路径 / 真实 QQ 号 / 个人邮箱，而**历史里**
# 同样带着它们（早期提交生成过含绝对路径的 preset 产物）。所以不能直接 `git push`，
# 要先在一个临时克隆里重写历史：
#   · 文件内容：把本机 home 路径、指定 QQ 号替换成通用占位符；
#   · 提交信息：同上，并把旧用户名替换成公开名；
#   · 提交作者/邮箱：替换成公开身份（建议 GitHub noreply）。
# 然后 force-push 到公开仓库。本地私有历史完全不受影响。
#
# 用法：
#   PUB_DEST=git@github.com:you/qq-bridge.git \
#   PUB_NAME="your-github-name" \
#   PUB_EMAIL="you@users.noreply.github.com" \
#   PUB_QQ=123456789 \            # 可选：额外擦除该 QQ 号
#   ./scripts/publish-public.sh
#
#   PUB_DRY_RUN=1 ...             # 只重写 + 自检，不 push
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${PUB_DEST:-$(git -C "$SRC" remote get-url public 2>/dev/null || true)}"
NAME="${PUB_NAME:-}"
EMAIL="${PUB_EMAIL:-}"
DRY_RUN="${PUB_DRY_RUN:-0}"
PUB_QQ="${PUB_QQ:-}"
OLD_NAME="$(git -C "$SRC" config user.name || true)"
PUB_HOME="${PUB_HOME:-$HOME}"

[[ -n "$DEST" ]] || { echo "缺少目标仓库：请设置 PUB_DEST" >&2; exit 1; }
[[ -n "$NAME" && -n "$EMAIL" ]] || { echo "缺少公开身份：请设置 PUB_NAME / PUB_EMAIL" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/qq-bridge-publish.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
echo "==> 克隆到 $WORK/repo"
git clone --no-hardlinks "$SRC" "$WORK/repo" >/dev/null 2>&1
cd "$WORK/repo"

# 同一段 Python 既做 tree-filter 也做 msg-filter：只按 env 里的规则做字面替换。
cat > "$WORK/rewrite.py" <<'PY'
import os
import sys

mode = sys.argv[1] if len(sys.argv) > 1 else 'tree'
home = os.environ.get('PUB_HOME', '').rstrip('/')
qq = os.environ.get('PUB_QQ', '').strip()
old_name = os.environ.get('OLD_NAME', '').strip()
new_name = os.environ.get('PUB_NAME', '').strip()

rules = []
if home:
    generic = '/Users/you' if home.startswith('/Users/') else '/home/you'
    rules.append((home.encode(), generic.encode()))
if qq:
    rules.append((qq.encode(), b'<QQ-id>'))
if mode == 'msg' and old_name:
    rules.append((old_name.encode(), new_name.encode() or b'author'))

def apply(data):
    new = data
    for a, b in rules:
        new = new.replace(a, b)
    return new

if mode == 'msg':
    sys.stdout.write(apply(sys.stdin.buffer.read()).decode('utf-8', 'replace'))
    sys.exit(0)

changed = 0
for root, dirs, files in os.walk('.'):
    if '.git' in root.split(os.sep):
        continue
    for name in files:
        path = os.path.join(root, name)
        try:
            data = open(path, 'rb').read()
        except OSError:
            continue
        new = apply(data)
        if new != data:
            open(path, 'wb').write(new)
            changed += 1
print(f'files changed: {changed}', file=sys.stderr)
PY

export PUB_HOME PUB_QQ OLD_NAME PUB_NAME
echo "==> 重写历史（文件内容 / 提交信息 / 身份）"
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --tree-filter "python3 '$WORK/rewrite.py' tree" \
  --msg-filter "python3 '$WORK/rewrite.py' msg" \
  --env-filter "
    export GIT_AUTHOR_NAME='$NAME'
    export GIT_AUTHOR_EMAIL='$EMAIL'
    export GIT_COMMITTER_NAME='$NAME'
    export GIT_COMMITTER_EMAIL='$EMAIL'
  " -- --all >/dev/null 2>&1

git remote remove origin 2>/dev/null || true
rm -rf .git/refs/remotes .git/refs/original
git reflog expire --expire=now --all
git gc --prune=now --quiet

echo "==> 隐私自检（应全部为 0）"
status=0
for pat in "$PUB_HOME" "$PUB_QQ" "$OLD_NAME"; do
  [[ -n "$pat" ]] || continue
  n=$(git log --all -p 2>/dev/null | grep -c -F -- "$pat" || true)
  echo "  $pat: $n"
  [[ "$n" != "0" ]] && status=1
done
[[ "$status" == "0" ]] || { echo "❌ 历史里仍有个人字符串，已中止（未 push）" >&2; exit 1; }
echo "  ✅ 干净"

echo "==> 作者身份"; git log --format='%an <%ae>' | sort -u

if [[ "$DRY_RUN" == "1" ]]; then
  echo "==> PUB_DRY_RUN=1：跳过 push"
  exit 0
fi

echo "==> force-push 到 ${DEST}（main）"
git remote add origin "$DEST"
git push --force origin HEAD:main
echo "==> 完成"
