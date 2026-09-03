SOVARA STUDIO — OPENCODE GREENFIELD CONTROL PACK (V1)

Это полный пакет для НОВОГО SOVARA Studio.
Старые control pack архивы не нужны.

УСТАНОВКА

1. Полностью закрой OpenCode.
2. Открой `E:\AI\SOVARA Studio`.
3. Удали старые control-pack файлы, если они там остались:
   - `.opencode`
   - `opencode.json`
   - `.sovara-studio-root`
   - `SEND_THIS_FIRST.txt`
   Старый продуктовый код НЕ удаляй, если он вдруг появился.
4. Распакуй СОДЕРЖИМОЕ этого ZIP прямо в `E:\AI\SOVARA Studio`.
5. Запусти OpenCode заново на этой папке.
6. Должен быть доступен `studio-plan`.
7. Отправь текст из `SEND_THIS_FIRST.txt`.

ПРОЦЕСС

TASK-001:
studio-plan -> человек проверяет архитектуру -> STOP

После approval:
studio-build TASK-002
-> studio-review
-> studio-verify
-> человек решает, идти ли дальше

Потом тот же цикл для каждой TASK.

ВАЖНО

- Git не обязателен.
- SOVARA Widgets запрещён.
- TASK-001 не должен блокироваться из-за пустого Studio.
- TASK-001 не создаёт код.
- TASK-002 создаёт только approved skeleton.
- Все следующие слои добавляются по одному.
