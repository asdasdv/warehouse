# Locus — локальный интерактивный склад

Запуск: двойной клик по `Start Locus.command`. Откроется http://127.0.0.1:5173. Окно запуска должно оставаться открытым. Остановка: Ctrl+C в этом окне.

## Что работает
- 18 зон, 240 стеллажей, 24 480 коробок электрических компонентов.
- Выбор зоны, стеллажа и коробки в 3D или в правой панели. Плавный переход камеры.
- Поиск по названию компонента, ID коробки или адресу стеллажа.
- Receive — приём целых коробок, Ship — отгрузка; Move в карточке — перемещение.
- Edit layout → Draw zone: протянуть прямоугольник на свободной земле. Place racks: нажимать внутри зоны для последовательной установки. Зелёный предпросмотр означает свободное место, красный — пересечение или выход за границы. Камера не приближается после установки. В режиме строительства рабочие панели скрыты; правая кнопка перемещает вид, колесо приближает, Top view включает вид сверху. Выход из инструмента: Escape.
- Новые зоны можно переименовать; пустые стеллажи и зоны можно удалить. Undo отменяет последние 10 изменений в текущем сеансе.
- Settings (шестерёнка) → экспорт/импорт JSON для резервной копии.
- Изменения сохраняются в localStorage этого браузера. Другой браузер имеет отдельные данные. Очистка данных сайта удалит сохранение — используйте экспорт.

## Управление камерой
Левая кнопка + движение — вращать. Правая кнопка + движение — перемещать вид. Колесо — приближать. Кнопка домика — общий вид. Для рисования зон камера переходит сверху.

## Границы прототипа
Это локальная демонстрация, не производственная WMS. Нет авторизации, общего серверного хранилища, реального QR-сканирования и интеграции с оборудованием. Числа Today стартуют с демонстрационных значений; календарные дни автоматически не переключаются. В Build mode доступны Small / Standard / Large и свои ширина, глубина, высота, число полок и мест. Configure rack меняет уже установленный стеллаж. Полки и места образуют постоянные адреса S1-P1 и т. д. Несколько коробок одного компонента могут делить адрес. Удалить занятые адреса нельзя. Количество коробок и занятых мест отображается отдельно; физическая вместимость и допустимая нагрузка не рассчитываются. 3D-коробки схематические, их размер не является реальным габаритом. Старые сохранения автоматически переводятся на адреса, IDs коробок и планировка сохраняются. Перед миграцией исходное сохранение копируется в отдельный ключ localStorage. Все компоненты и геометрия хранятся в проекте; шрифты имеют системный запасной вариант.

## Разработка
`npm run dev` — локальный сервер, `npm test` — проверка логики учёта, `npm run build` — сборка в dist.

### Rack-to-rack robot simulation
The main 3D scene now routes four lift-equipped concept robots around the current rack footprints on a 2 m navigation grid with body clearance. Tasks reference actual box IDs, alternate between rack relocation and dispatch, and reserve boxes until completion. Robots wait for nearby vehicles and attempt a detour. Unreachable rack ports are skipped. Routes are schematic, not a certified fleet planner.

Pickup, carriage and delivery change the scene's session-only inventory overlay. Saved stock, history and the main stock counters remain unchanged; reload resets robot tasks and this overlay. Destination addresses avoid mixing different component types; physical capacity remains unvalidated. Automatic task generation is not a production WMS workflow. The mast is a conceptual loading animation, not a validated real-world picking mechanism.
