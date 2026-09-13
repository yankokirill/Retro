# Branch protection на `main` — ручная настройка

- **Статус:** не настроено агентом. В среде этой сессии нет `gh` CLI и токена GitHub API — `gh api repos/.../branches/main/protection` выполнить некому. Локально прямые коммиты и push в `main` уже блокирует хук `.claude/hooks/guard-bash.mjs` (включён файлом `.claude/protect-main`, В3), но это ограничивает только агента в Claude Code, а не защищает `main` на стороне GitHub от прямого push кем угодно с правами записи.

## Что настроить (GitHub → Settings → Branches → Add rule, паттерн `main`)

- [x] Require a pull request before merging
  - [x] Require approvals: 0 (проект соло, но чтобы был явный «зелёный» PR, а не прямой push) — можно оставить 0 и полагаться только на статус-чек ниже
- [x] Require status checks to pass before merging
  - обязательный чек: `check` (job из `.github/workflows/ci.yml`)
  - [x] Require branches to be up to date before merging
- [x] Do not allow bypassing the above settings (иначе owner-права репозитория обходят правило)
- [ ] Require linear history — не обязательно, но упрощает `git log`
- [ ] Restrict who can push — не нужно для соло-проекта

## Как проверить, что применилось

```bash
gh api repos/<owner>/<repo>/branches/main/protection
```

Непустой ответ (не `404 Branch not protected`) — правило действует. Именно эту команду ждёт скилл `milestone-check` для В3.

## Если появится `gh` с токеном

Можно настроить одной командой вместо UI:

```bash
gh api -X PUT repos/<owner>/<repo>/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  -f required_status_checks[strict]=true \
  -f 'required_status_checks[contexts][]=check' \
  -F enforce_admins=true \
  -f required_pull_request_reviews[required_approving_review_count]=0 \
  -F required_linear_history=false \
  -F allow_force_pushes=false \
  -F allow_deletions=false
```

Тогда этот файл можно удалить, а пункт чеклиста В3 в `CLAUDE.md` — отметить выполненным со ссылкой на дату применения.
