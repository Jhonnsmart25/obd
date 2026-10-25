# Traductor OBD

PWA que traduce los códigos de falla OBD-II a lenguaje sencillo, con semáforo de gravedad (verde, amarillo, rojo).
Cuentas propias, 7 días de prueba gratis y suscripción mensual con Stripe. Node.js + Express, lista para Render con Docker.

Solo **lee** los códigos del auto: no borra fallas ni toca el inmovilizador ni ningún módulo.

## Estructura (todo en la raíz del repositorio)

```
server.js         servidor: cuentas, Stripe, webhook y guard de suscripción
Dockerfile        imagen para Render
package.json      solo 2 dependencias: express y stripe
data/dtc.json     base con los 20 códigos más comunes traducidos
lib/              almacén de usuarios (JSON) y contraseñas/sesiones
public/           la PWA (app.js, obd.js, styles.css, sw.js, manifest, iconos)
test/             24 pruebas
```

## Cómo funciona el acceso

1. La persona crea su cuenta (correo y contraseña).
2. Sin prueba ni suscripción vigente, la app la manda a Stripe Checkout (`POST /api/create-checkout-session`, con `trial_period_days: 7`). La prueba se da **una sola vez por cuenta**.
3. Stripe avisa por webhook (`POST /api/webhook`): `checkout.session.completed`, `customer.subscription.created/updated` y `customer.subscription.deleted`. Con eso la cuenta pasa a `trialing`, `active` o `canceled`.
4. El servidor solo entrega la base de traducciones (`GET /api/dtc`) si el estado es `trialing` o `active`. Si no, responde 402 y la app vuelve al cobro.
5. Respaldo: al regresar de Stripe, la app confirma la sesión directo con Stripe (`/api/checkout/confirm`), por si el webhook tarda (en Render gratis el servicio "duerme").

## Puesta en marcha

### 1. Stripe (modo de prueba primero)
1. Productos → crea un producto con precio **recurrente mensual**. Copia el ID del precio (`price_...`) → `STRIPE_PRICE_ID`.
2. Desarrolladores → Claves de API → clave secreta (`sk_test_...`) → `STRIPE_SECRET_KEY`.
3. Configuración → Facturación → **Portal de clientes**: actívalo (permite cancelar y cambiar tarjeta).
4. Después de desplegar en Render: Desarrolladores → Webhooks → agrega `https://TU-APP.onrender.com/api/webhook` con los eventos:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
   Copia el "secreto de firma" (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`.

### 2. GitHub
Sube el contenido de esta carpeta a un repositorio (los archivos quedan en la raíz, sin carpetas anidadas). `.gitignore` ya excluye `.env` y `node_modules`.

### 3. Render
New → **Web Service** → conecta el repositorio → Runtime **Docker**. En Environment agrega:

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://TU-APP.onrender.com` (sin `/` al final) |
| `JWT_SECRET` | texto largo aleatorio: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `STRIPE_SECRET_KEY` | `sk_...` |
| `STRIPE_PRICE_ID` | `price_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
| `DATA_DIR` | `/var/data` (si agregas un Disco, ver abajo) |

También hay un `render.yaml` opcional (Blueprint) con estas variables. Revisa que `/healthz` responda `ok`.

### ⚠️ Importante: los usuarios se guardan en un archivo JSON
Es un prototipo. En Render el disco normal **se borra en cada deploy o reinicio**, y con él las cuentas y el estado de suscripción.
Antes de lanzar de verdad, haz una de dos: (a) agrega un **Disco persistente** de Render montado en `/var/data` con `DATA_DIR=/var/data` (requiere plan de pago y una sola instancia), o (b) cambia `lib/store.js` por una base de datos (por ejemplo Supabase). La interfaz del almacén es pequeña: `byId`, `byEmail`, `byCustomer`, `create`, `update`, `seen`, `markSeen`, `delete`.

### 4. Probar en local
```
npm install
cp .env.example .env   # llena los valores y expórtalos (el servidor lee variables de entorno)
npm test
npm start
```
Para el webhook en local: `stripe listen --forward-to localhost:3000/api/webhook`. Tarjeta de prueba: `4242 4242 4242 4242`.

## Instalar en Android
Abre la URL en Chrome → menú → "Instalar app" (o el botón "Instalar en mi teléfono" en Cuenta).

## Adaptador y Bluetooth
- Web Bluetooth funciona en **Chrome para Android** (no en iPhone). Necesita un adaptador **ELM327 con Bluetooth de bajo consumo (BLE)**. Los ELM327 "clásicos" económicos no se pueden usar desde el navegador.
- La app prueba los perfiles BLE más comunes (`FFF0`, `FFE0` y `18F0`). Si tu adaptador usa otro, agrégalo en `BLE_PROFILES` de `public/obd.js`.
- **Modo demo**: simula un adaptador con 4 escenarios, usa exactamente el mismo código de lectura que el Bluetooth real.
- Las lecturas se procesan en el teléfono; no se envían al servidor.

## Qué falta por probar (no se pudo aquí)
- No pude instalar `express` ni `stripe` en mi entorno, así que las rutas se probaron con un express y un Stripe simulados, más una prueba en navegador con un servidor equivalente. Corre `npm install && npm test` y haz una compra de prueba completa en Stripe antes de lanzar.
- El Bluetooth real **no se probó con un adaptador ni con un auto**. La decodificación de respuestas está probada con ejemplos del formato ELM327, pero los adaptadores varían. Prueba con tu adaptador y ajusta si hace falta.
- Las traducciones son orientativas; que las revise un mecánico antes de publicar.

## Mejoras sugeridas
Más códigos (agrega entradas a `data/dtc.json`, la app no cambia), historial por vehículo, borrar códigos con confirmación (modo 04) y correo para recuperar contraseña.
