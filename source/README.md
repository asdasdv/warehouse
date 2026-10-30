# Locus — концепт склада с роботами

Концепт-сайт: 3D-склад электрических компонентов, по которому постоянно ездят роботы.
Ничего не сохраняется — после перезагрузки страницы демо-склад начинается заново.

## Как это работает
- Сайт стартует на `seed('large')`: 35 зон, 1 203 стеллажа, в ячейке 2 коробки — 70 120 мест, ~44,7 тыс. коробок,
  ~76 роботов. `seed('small')` (8 зон, 57 стеллажей, ~2 000 коробок, как в макете Figma «Phoenix Drafts») остаётся
  для быстрых тестов. Всё живёт в памяти браузера.
- Симуляция идёт всегда: на Receiving приходят коробки, роботы раскладывают их по адресам;
  появляются заказы, роботы везут коробки на Dispatch, оттуда они уезжают к клиенту.
  Поток сам держит запас на уровне стартового.
- Действия пользователя превращаются в работу для роботов:
  - **Receive** — товар из каталога или новый (Create new), ячейка: рекомендованная или «зона → стеллаж → ячейка»;
    коробки приезжают на Receiving, роботы раскладывают их;
  - **Move** (в карточке коробки) — робот перевозит коробку в другую ячейку;
  - **Ship** — из топбара (товар, количество, Dispatch) или из карточки коробки, робот везёт коробки на Dispatch.
  - Каждая такая коробка — карточка в панели Tasks (Coming → Loading → Moving/Delivering/Storing), задачу можно
    отменить, пока робот не забрал коробку. По завершении — тост (одновременно завершённые — одним тостом).
- **Edit warehouse layout** (меню-шестерёнка) — редактор по макету: план 2D (SVG) и 3D, инструменты
  Select / Hand / Zone (Rectangle, Polygon, Edit points) / Place row / Measure / Robot access, список Objects,
  Inspector (имя, цвет, размеры зоны, позиция и поворот стеллажа), Undo/Redo. Все правки — черновик:
  Save сохраняет, Cancel спрашивает «Discard changes?» и откатывает. Роботы перестраивают маршруты под новую планировку.
- Панель справа: склад → зона → стеллаж → полка → ячейка → коробка; All zones / All racks — таблицы.
- Inventory (фильтры Zone/Rack/Shelf/Product/SKU/Received date), History, Fleet — живые представления симуляции.

## Разработка
```
npm install
npm run dev     # http://127.0.0.1:5173
npm test        # логика склада и роботов
npm run build   # сборка в dist/
```
Папка `../locus-cloudflare` — содержимое `dist/` для деплоя на Cloudflare Pages.

Главные файлы: `main.js` (интерфейс и окна), `phoenix-panel.js` (правая панель), `tasks-panel.js`, `locus.css` (токены из Figma), `layout-editor.js` (редактор планировки), `warehouse-robots.js` (симуляция — единственный источник
данных о коробках), `scene.js` (3D), `model.js` / `storage.js` (склад, адреса, стеллажи).

### Cloudflare Workers Builds

The repository root contains `wrangler.jsonc` for the existing Worker `warehouse`. It serves the committed `locus-cloudflare/` directory. Set the Workers Builds root directory to the repository root; the deployment command is `npx wrangler deploy`. No build command is required when deploying the committed bundle. The configured preview-branch command is `npx wrangler preview`; it requires the top-level `previews: {}` block in `wrangler.jsonc`. Assets and compatibility settings remain at the top level.

Validate the deployment configuration from the repository root with `npx wrangler deploy --dry-run`. This checks packaging without publishing. If a Cloudflare check fails before a build log is produced, inspect the account/build settings in the Cloudflare dashboard; local application tests cannot validate those settings.
