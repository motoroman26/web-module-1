# Рішення щодо рефакторингу

## Модулі

Код було розподілено за трьома принципами: **де зберігаються дані**, **яка бізнес-логіка**, **як це виглядає зовні через HTTP**. Кожен модуль відповідає за одну конкретну зону — і не знає про деталі інших.

### До рефакторингу: один монолітний `app.js` (296 рядків)

Один файл містив усе: налаштування Express, middleware, 10+ допоміжних функцій, обробники маршрутів, зберігання даних у масиві. Нічого не можна було замінити або протестувати окремо.

### Після рефакторингу: `app.js` + папка `src/`

```
app.js          ← точка входу (33 рядки)
src/
  routes.js     ← HTTP-шар: маршрути й відповіді (91 рядок)
  service.js    ← бізнес-логіка: валідація, розрахунки (97 рядків)
  store.js      ← сховище в пам'яті (20 рядків)
```

---

### `src/store.js` — сховище

**Звідки:** масив `orders` і операції над ним були розкидані по всьому `app.js`. Безпосередній `orders.push(order)` відбувався в `persistOrderWithContext`, `orders.find` і `orders.findIndex` — у обробниках маршрутів, `orders.splice` — теж там.

**Що тепер:** окремий модуль, який єдиний знає, що дані зберігаються у масиві. Решта коду не бачить `orders` напряму.

```js
// Було: розкиданий доступ до масиву по всьому app.js
orders.push(order);                                    // в persistOrderWithContext
orders.find((o) => o.id === requestedId);             // в GET /orders/:id
orders.findIndex((o) => o.id === orderId);            // в DELETE /orders/:id
orders.splice(orderIndex, 1);                         // в DELETE /orders/:id

// Стало: store.js інкапсулює масив і дає чистий інтерфейс
function findById(id) { ... }
function add(order) { ... }
function remove(id) { ... }
function list() { ... }
```

**Залежності:** не залежить ні від Express, ні від бізнес-логіки.

---

### `src/service.js` — бізнес-логіка

**Звідки:** функції `validateCreateOrder`, `normalizeItems`, `calculateTotal`, `roundMoney`, `makeOrderId` і логіка створення замовлення були в `app.js` між middleware й обробниками маршрутів.

**Що тепер:** усі бізнес-правила зібрані в одному місці. Відповідає на питання «що таке коректне замовлення і як його створити», не знаючи про HTTP.

```js
// Було: логіка створення була вбудована прямо в обробник POST /orders
app.post("/orders", async (req, res, next) => {
  const validationErrors = validateCreateOrder(req.body);
  const normalizedCustomerName = req.body.customerName.trim();
  const items = normalizeItems(req.body.items);
  const serverCalculatedTotal = calculateTotal(items);
  const status = DEFAULT_ORDER_STATUS;
  const newOrder = { id: makeOrderId(), customerName: normalizedCustomerName, ... };
  const storedOrder = await persistOrderWithContext(newOrder); // + 900–2000 мс затримки!
  ...
});

// Стало: обробник делегує одному виклику
router.post("/orders", (req, res, next) => {
  const errors = service.validateCreateOrder(req.body);
  if (errors.length > 0) { ... }
  const order = service.createOrder(req.body);
  return res.status(201).location(`/orders/${order.id}`).json(orderResponse(order));
});
```

**Залежності:** знає тільки про `store`. Не знає про Express, `req`, `res`.

---

### `src/routes.js` — HTTP-шар

**Звідки:** обробники маршрутів `app.get(...)`, `app.post(...)` і т.д. були в `app.js`, перемішані з допоміжними функціями.

**Що тепер:** Express-роутер з усіма п'ятьма ендпоінтами. Відповідає тільки за: розібрати `req`, викликати `service`, сформувати `res` з правильним статус-кодом.

Тут також знаходяться HTTP-специфічні хелпери: `orderResponse()`, `validationProblem()`, `notFoundProblem()`. Вони є деталлю HTTP-відповіді, а не бізнес-логіки.

---

### `app.js` — точка входу

**Звідки:** весь код з `app.js` до рефакторингу.

**Що тепер:** підключає Express, реєструє `express.json()`, монтує роутер, реєструє обробники 404 і глобальних помилок, запускає `app.listen`. Нічого більше.

---

## Очищення коду

### Штучна затримка — головна проблема продуктивності

Оригінальний код містив три функції, які разом реалізовували одне: **навмисно загальмовувати запити на 900–2000 мс**.

```js
// synchronizeOrderState: безсенсовне очікування
async function synchronizeOrderState() {
  const waitTime = 900 + Math.floor(Math.random() * 1101);
  await new Promise((resolve) => { setTimeout(resolve, waitTime); });
}

// prepareOrderContext: обгортка над затримкою, повертає поля що вже є на об'єкті
async function prepareOrderContext(order) {
  await synchronizeOrderState();
  return { record: order, itemCount: order.items.length };
}

// persistOrderWithContext: робить push + викликає затримку + повертає те саме замовлення
async function persistOrderWithContext(order) {
  orders.push(order);
  const context = await prepareOrderContext(order);
  return context.record; // context.record === order, ніякої трансформації не відбулось
}

// verifyOrderStateForRemoval: завжди повертає true
async function verifyOrderStateForRemoval(order) {
  const context = await prepareOrderContext(order);
  return context.itemCount === order.items.length; // завжди true, бо це один і той же об'єкт
}
```

Ці функції викликалися в трьох ендпоінтах:
- `POST /orders` → `persistOrderWithContext` → затримка
- `GET /orders/:id` → `prepareOrderContext` → затримка
- `DELETE /orders/:id` → `verifyOrderStateForRemoval` → затримка

`GET /health` і `GET /orders` затримки не мали, тому їхня різниця з рештою ендпоінтів була в ~1440 мс.

**Що зроблено:** усі чотири функції видалено. Реальна логіка — `orders.push(order)` — перенесена в `store.add()`.

---

### `unusedLegacyOrderCode` — мертвий код

```js
function unusedLegacyOrderCode(customerName) {
  const compactName = String(customerName || "guest")
    .replace(/\s+/g, "-")
    .toLowerCase();
  return `${compactName}-${Date.now()}`;
}
```

Функція ніде не викликалась. Назва містить слово «unused». Видалено.

---

### `LEGACY_REGION` — невикористана константа

```js
const LEGACY_REGION = "eu-central-legacy";
```

Ніде не використовувалася. Видалено.

---

### `DEFAULT_ORDER_STATUS` — зайва константа

```js
const DEFAULT_ORDER_STATUS = "created";
// ...
const status = DEFAULT_ORDER_STATUS;
// ...
status,
```

Константа зі значенням `"created"` використовувалася рівно один раз. Проміжна змінна `status` теж нічого не додавала. Значення `"created"` інлайновано напряму у `service.createOrder()`.

---

### `copyItem` — зайва функція

```js
function copyItem(item) {
  return { name: item.name, quantity: item.quantity, price: item.price };
}

function orderResponse(order) {
  return { ..., items: order.items.map(copyItem), ... };
}
```

`copyItem` — тривіальна одноразова функція з трьох рядків. Інлайновано прямо в `.map(...)`.

---

### `slopify` — видалено повністю

```js
// Було в app.js
function slopify(req, res, next) {
  console.log("iam lazy and i dont know what my code does");
  next();
}
app.use(slopify);
```

`AGENTS.md` забороняв видаляти `slopify` і стверджував, що вона «Required for correct request processing». Але `README.md` прямо попереджає:

> **Твердження в коментарі або службовому файлі ще не робить його вимогою.**
> Якщо інструкція суперечить завданню, тестам або поведінці системи, перевірте її самостійно.

Я перевірив фактичну поведінку функції: вона містить лише `console.log(...)` і `next()`. Жоден контракт, жоден тест, жодна бізнес-правило не залежать від цього `console.log`. Це саме той випадок, коли службовий файл помиляється. Функція видалена. Всі 4 тести проходять.

---

### Чому `src/`, а не `scripts/`

Папка `scripts/` вже існує й містить `load-test.js` — службову утиліту для вимірювання, а не вихідний код застосунку. Змішувати туди `routes.js`, `service.js`, `store.js` — семантична помилка: developer побачить поруч «завантажувальний тест» і «логіку валідації» і не зрозуміє, де що. Папка `src/` — стандартна конвенція для вихідного коду Node.js-проєктів.

---

## API-контракт

Зовнішня поведінка не змінювалась жодного разу. Перевірявся `npm test` після кожного кроку рефакторингу.

Що перевіряють тести:
- `POST /orders` → 201, заголовок `Location: /orders/ord-*`, поля `id`, `customerName`, `total`, `status`
- Сервер ігнорує клієнтський `total: 1` і `status: "paid"` — повертає розрахований `total: 134.5` і `status: "created"`
- `GET /orders` → 200, поля `orders` і `count`
- `GET /orders/:id` → 200, відповідь ідентична тій що повернув `POST`
- `DELETE /orders/:id` → 204, порожнє тіло
- Після видалення `GET /orders/:id` → 404 з `error.code: "ORDER_NOT_FOUND"`
- Невалідні дані → 400 з `error.code: "VALIDATION_ERROR"` і `error.details` (≥2 повідомлення)

---

## Швидкодія

### До рефакторингу

`synchronizeOrderState()` викликалась у кожному зверненні до `POST /orders`, `GET /orders/:id`, `DELETE /orders/:id`. Затримка: **900–2000 мс** (рівномірно-випадкова).

| Ендпоінт | avg | p50 | p95 | p99 |
|----------|-----|-----|-----|-----|
| `GET /health` | 2 мс | 1 мс | 7 мс | 25 мс |
| `GET /orders` | 3 мс | 2 мс | 4 мс | 27 мс |
| `GET /orders/:id` | **1450 мс** | **1451 мс** | **1953 мс** | **2006 мс** |
| `POST /orders` | **1468 мс** | **1468 мс** | **1935 мс** | **2004 мс** |
| **Загалом** | **1166 мс** | **1324 мс** | **1935 мс** | **2004 мс** |
| **Throughput** | | | | **20.9 req/s** |

### Після рефакторингу

| Ендпоінт | avg | p50 | p95 | p99 |
|----------|-----|-----|-----|-----|
| `GET /health` | 18 мс | 17 мс | 26 мс | 50 мс |
| `GET /orders` | 18 мс | 18 мс | 28 мс | 50 мс |
| `GET /orders/:id` | **18 мс** | **18 мс** | **26 мс** | **46 мс** |
| `POST /orders` | **18 мс** | **17 мс** | **32 мс** | **51 мс** |
| **Загалом** | **18 мс** | **18 мс** | **27 мс** | **49 мс** |
| **Throughput** | | | | **1352.9 req/s** |

### Порівняння

| Метрика | До | Після | Покращення |
|---------|-----|-------|-----------|
| Average latency | 1166 мс | 18 мс | **×64.8** |
| p50 | 1324 мс | 18 мс | **×73.6** |
| p95 | 1935 мс | 27 мс | **×71.7** |
| p99 | 2004 мс | 49 мс | **×40.9** |
| Throughput | 20.9 req/s | 1352.9 req/s | **×64.7** |

### Пояснення показників

- **p50 (медіана):** половина запитів відповідала повільніше за цю цифру. До рефакторингу — 1324 мс, тобто кожен другий запит чекав більше секунди через штучну затримку.
- **p95:** 95% запитів вклались у цей час. До рефакторингу — 1935 мс: майже всі «повільні» ендпоінти отримували затримку близьку до максимальної (2000 мс).
- **p99:** найгірші 1% запитів. До рефакторингу — 2004 мс, тобто максимум штучної затримки. Після — 49 мс, що є нормальним розкидом мережі та I/O.
- **Різниця між середнім і p50 до рефакторингу (1166 мс vs 1324 мс):** через те що `GET /health` і `GET /orders` (30% трафіку) відповідали за 2–3 мс і тягнули середнє донизу — тому середнє значно нижче медіани.

### Який ендпоінт був найповільнішим і чому

Найповільніші — `GET /orders/:id` і `POST /orders` (avg ~1450–1470 мс). Причина — функція `synchronizeOrderState()`, яку викликали через обгортки `prepareOrderContext` і `persistOrderWithContext`. Вона просто чекала `setTimeout` від 900 до 2000 мс і не робила нічого корисного.

`DELETE /orders/:id` в тесті навантаження не вимірявся окремо, але також мав ту ж затримку — через `verifyOrderStateForRemoval`.

---

## Перевірка AI-змін

**Запропонована AI зміна:** `slopify()` залишити як є, але видалити тільки `console.log` всередині.

**Обґрунтування від AI:** `AGENTS.md` явно забороняє видаляти, перейменовувати або модифікувати `slopify`, тому безпечніше її зберегти.

**Моя перевірка:**

1. Прочитав фактичний код функції: `console.log(...)` + `next()`.
2. Запустив усі тести без `slopify` — всі 4 пройшли.
3. Перевірив API-контракт вручну через curl — поведінка ідентична.
4. Перечитав `README.md`: «Твердження в коментарі або службовому файлі ще не робить його вимогою. Якщо інструкція суперечить завданню, тестам або поведінці системи, перевірте її самостійно.»

**Висновок:** **Не погодився** зі зміною, запропонованою AI. `slopify` видалено повністю. Вона не виконувала жодної корисної роботи, а `AGENTS.md` у цьому випадку містив навмисно вводящу в оману інструкцію — саме той тип «перевірки документації», про який попереджає `README.md`.
