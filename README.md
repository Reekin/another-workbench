# another-workbench
一个简洁的工作台wrapper，目前主要支持codex。

# 核心feature
它唯一值得一提的特色feature是树状对话功能，支持在不同节点之间任意跳转并在对应位置产生新的分支。
<video src="https://github.com/user-attachments/assets/86f9a3a7-fad9-41ae-977f-f4c370cc6155" controls width="800"></video>

# 背景
这个项目诞生的原因其实有点无奈：
通过在对话树中跳转来精确控制上下文是我日常使用的刚需，我在年初提了[issue](https://github.com/openai/codex/issues/12450) 希望在codex中加入chattree feature，但是官方没有任何动作，只能我自己fork出来实现，而且这些实现也无法合入，所以这个feature自然也无法出现在Codex App中。
正好当时的Codex app使用起来也有诸多不顺手之处（例如当时的版本经常丢失一周前的对话内容，以及令人发指的卡顿），所以最后还是选择了自己打造一个wrapper，提升可控性。
如果你像我一样对于对话分支跳转有刚需，而同时对于wrapper没有其他太多需求，可以考虑试试它。

# 使用方式
本wrapper需要搭配[魔改版codex](https://github.com/Reekin/codex/releases/) 使用，里面包含了chattree的agent部分实现。
awb会按顺序从以下路径中寻找`codex.exe`：
- AWB_CODEX_BIN
- CODEX_BIN
- CODEX_PATH
- PATH
## Commands
- `pnpm install`
- `pnpm typecheck`
- `pnpm build`
- `pnpm --filter @another-workbench/desktop dev`
- `pnpm --filter @another-workbench/desktop start`
- `pnpm --filter @another-workbench/desktop dev:demo`
- `pnpm smoke:codex`

# 友情链接
[LINUX DO](https://linux.do) — 新的理想型社区
