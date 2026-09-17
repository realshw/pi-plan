# pi-plan

Multi-agent orchestration for [Pi](https://pi.dev): a master Pi session spawns slave sessions, one task each, and collects their reports. Slaves open in tmux windows.

## Use

```bash
pi install git:github.com/realshw/pi-plan
```

Run `pi` inside a tmux pane, then:

```
/plan <goal>
```

The master plans the work, spawns agents, and reports back.

## Dev

```bash
npm install
```

Work lands on `master`. No unit tests and a clean typecheck are required everywhere.
