# Durabilidad desde cero: logs, SQLite, pi-durable y actores

¿Cómo puede un agente estar ejecutando herramientas, perder el proceso que lo ejecuta y continuar
más tarde sin empezar todo de nuevo? No lo consigue una única tecnología: varias capas resuelven
problemas distintos.

Esta guía parte de conocimientos básicos de programación. Primero explica qué es un log; después,
cómo SQLite protege los datos, cómo pi-durable guarda el trabajo y cómo Cloudflare Durable Objects
y Rivet permiten separar ese trabajo de una máquina concreta.

**Alcance:** pi-durable 1.2.0, la versión fijada por este proyecto. Cloudflare está implementado en
pikit. Rivet se explica como tecnología investigada, **no como un despliegue disponible en pikit**:
la [propuesta de integración](../features/deployment-rivet.md) se estudió sobre Rivet 2.3.27,
commit `aa8800b`. Los detalles internos de estas plataformas pueden cambiar.

## 1. El problema: ejecutar no es lo mismo que guardar

Un proceso es un programa en ejecución. Sus variables, promesas y llamadas pendientes viven en
**RAM**, una memoria rápida que no sobrevive a la desaparición del proceso.

El disco sí sobrevive normalmente a un reinicio. Pero hay que distinguir tres fallos:

| Fallo | Qué puede seguir existiendo |
|---|---|
| Se cae el proceso | El sistema operativo, su caché de archivos y el disco |
| Se apaga la máquina | El disco, pero no la RAM ni las escrituras que solo estaban en caché |
| Se pierde el disco o la máquina entera | Solo las copias guardadas fuera de ella |

Además, una plataforma puede detener un proceso deliberadamente para actualizarlo o liberar
recursos. Eso no debería obligar al usuario a repetir su petición.

Un agente añade un problema: además de calcular, **produce efectos externos**. Puede enviar un
mensaje, modificar un archivo o llamar a una API de pagos. Si muere, necesitamos saber:

- qué petición habíamos aceptado;
- qué pasos terminaron;
- qué paso estaba pendiente;
- qué efectos pudieron ocurrir aunque no alcanzáramos a guardar su resultado.

Guardar solo la conversación no responde necesariamente a todas esas preguntas.

## 2. Qué significa «log» aquí

No hablamos principalmente de mensajes de depuración como `INFO: servidor iniciado`. Un log, en
este contexto, es una **secuencia ordenada de registros** a la que se añaden registros al final.
Esta propiedad se llama *append-only*.

Piensa en una cuenta bancaria:

```text
Registro 1: ingreso        +1.000 EUR
Registro 2: supermercado     -80 EUR
Registro 3: alquiler        -800 EUR
                           --------
Saldo calculado:             120 EUR
```

El saldo es un **estado**. Los movimientos explican cómo se llegó a él. Con los movimientos y las
reglas de cálculo podemos reconstruirlo.

Esto da varias ventajas:

- **Orden:** sabemos qué registro viene antes de cuál, sin depender de relojes perfectamente iguales.
- **Recuperación:** podemos volver a aplicar registros confirmados tras un fallo.
- **Replicación:** otra máquina puede recibir los registros que le faltan.
- **Historial:** si lo conservamos, podemos reconstruir estados anteriores.

El orden tiene un alcance: el log de una conversación o de una base no ordena automáticamente todos
los acontecimientos del mundo. Sus números pueden ser crecientes sin ser consecutivos.

### No hace falta releer desde el principio siempre

Podemos guardar una **foto del estado**, llamada *snapshot*, y aplicar después solo los registros
posteriores:

```text
Foto: saldo tras el registro 1.000
                  + registros 1.001 a 1.050
                  = saldo actual
```

Los sistemas pueden compactar o eliminar tramos antiguos cuando ya no son necesarios. *Append-only*
no implica «guardar todos los bytes para siempre».

Tampoco significa que cualquier sistema construido con logs reconstruya todo su estado desde una
única lista de eventos: puede combinar historial, registros actuales y snapshots. pi-durable lo hace.

## 3. Por qué una escritura no basta: cachés, transacciones y commits

Cuando un programa escribe un archivo, el sistema operativo puede dejar los datos temporalmente en
RAM. Que la llamada termine no significa siempre que esos datos estén ya en almacenamiento
persistente.

Una operación como `fsync()` solicita sincronizar los datos con ese almacenamiento. La garantía
final también depende de que el sistema de archivos y el dispositivo cumplan sus contratos.

Hay otro problema: un cambio puede necesitar varias escrituras. Una transferencia bancaria debe
restar 50 EUR a una cuenta y sumarlos a otra. Si solo ocurre la primera mitad, desaparece dinero.

Una **transacción atómica** agrupa cambios para que sean visibles **todos o ninguno**. El momento en
que se confirma se llama **commit**.

Conviene separar dos propiedades:

- **Atomicidad:** después de recuperarnos no veremos media transferencia.
- **Durabilidad:** una transferencia confirmada sigue existiendo tras los fallos que prometemos soportar.

Podemos tener atomicidad y, con una configuración menos estricta, perder los últimos commits tras
un apagón. No es lo mismo perder una transacción entera que tener una base incoherente.

## 4. SQLite: proteger cambios mediante un journal o un WAL

SQLite es una base de datos que se ejecuta dentro del programa. No requiere un servidor de bases
de datos aparte. Organiza la base en **páginas**, bloques de tamaño fijo, habitualmente de 4 KiB
(el tamaño es configurable).

### Rollback journal: guardar cómo deshacer

En su modo tradicional, SQLite guarda las versiones originales de las páginas antes de modificarlas.
Si algo falla, puede restaurarlas. En el modo `DELETE`, eliminar el journal marca el commit.

La idea es: **guardar cómo deshacer antes de sobrescribir**.

### WAL: guardar la versión nueva antes de incorporarla al archivo principal

WAL significa **Write-Ahead Log**, o registro de escritura anticipada. En este modo, SQLite añade
las nuevas versiones de las páginas a un archivo separado en vez de sobrescribir inmediatamente
la base principal.

```text
Base principal              WAL: nuevas versiones de páginas
+----------+                +-------------------------------------------+
| página 1 |                | página 2 nueva                            |
| página 2 |                | página 3 nueva + marca COMMIT              |
| página 3 |                | página 1 nueva, sin transacción confirmada |
+----------+                +-------------------------------------------+

Estado confirmado = base principal + transacciones válidas del WAL
```

La marca de commit y las comprobaciones de integridad permiten distinguir una transacción completa
de una escritura interrumpida. Un lector obtiene la versión de cada página correspondiente a su
vista de la base: a veces estará en el archivo principal y a veces en el WAL.

Más tarde, un **checkpoint de SQLite** incorpora cambios del WAL al archivo principal. El WAL puede
reutilizarse cuando sea seguro; no necesariamente se vacía físicamente en cada checkpoint.

Dos consecuencias importantes:

1. Un commit puede estar confirmado aunque sus páginas todavía no estén en el archivo principal.
2. Copiar solo el archivo `.db` mientras la base está activa puede omitir cambios. Para un backup
   hay que usar un procedimiento compatible con SQLite.

### La configuración decide cuánto resiste un apagón

En modo WAL:

- `synchronous = FULL` sincroniza el WAL en cada commit.
- `synchronous = NORMAL` evita esa sincronización en cada commit y la realiza en momentos como los
  checkpoints. Resiste caídas del proceso, pero un apagón o reinicio brusco puede perder commits recientes.

**Matiz de este proyecto:** el backend Node propio de pi-durable configura `NORMAL`. pikit usa otro
camino: [su adaptador](../packages/pi-adapter/src/sql.ts) sobre `storage.sql`.
[storage-sqlite](../registry/components/storage-sqlite/files/src/pikit/storage-sqlite/index.ts)
activa WAL, pero **no fija `synchronous`**. No debemos atribuirle automáticamente la configuración
del backend Node de Pi; hay que consultar el valor efectivo de `PRAGMA synchronous`.

WAL es un mecanismo de recuperación local, **no una copia de seguridad ni replicación por sí solo**.

## 5. pi-durable: guardar también el estado del trabajo

SQLite sabe guardar filas, pero no sabe qué significa «el agente estaba esperando el resultado de
esta herramienta». pi-durable representa esa información explícitamente.

Su regla central es:

> Only committed state is observable.
>
> Solo es observable el estado que ya se ha confirmado en almacenamiento.

Esto no quiere decir que cada cálculo interno sea persistente. Quiere decir que las vistas y los
eventos del Harness publican **estado confirmado**, no avances que solo existen en RAM.

### Sus piezas

| Pieza | Qué representa |
|---|---|
| **Harness / Session** | El almacenamiento abierto y la maquinaria que coordina el trabajo; una Session tiene una sola línea de commits |
| **Conversation** | Una conversación con su transcript y configuración |
| **Entry** | Un registro inmutable del transcript: mensaje, respuesta o resultado de herramienta |
| **Document** | Estado JSON que se actualiza dentro de commits: inbox, progreso, gasto o estado propio |
| **Task** | Trabajo organizado en fases, con un checkpoint persistente |
| **Submission** | Una petición admitida cuyo resultado podemos consultar, también después de reiniciar |

Un commit puede añadir una entry, actualizar un documento y avanzar una tarea **atómicamente**.
No es solo «escribir una línea al final de un archivo»: en SQLite se traduce en una transacción
sobre varios registros y tablas. No todo el almacenamiento interno es un historial inmutable.

La línea de commits serializa **las mutaciones**, no todo el trabajo: llamadas a modelos y
herramientas pueden ejecutarse concurrentemente según sus reglas. Los efectos externos quedan
fuera de la transacción para no mantenerla abierta mientras esperamos a la red.

Y la durabilidad depende del backend. Con `MemoryStorage`, el mismo protocolo funciona, pero no
sobrevive al proceso. Con SQLite o JSONL persistentes, sí puede hacerlo según sus garantías.

### Una tarea es una máquina de estados

En vez de depender únicamente de una función suspendida en RAM, guardamos algo como:

```text
Tarea 42
  fase: esperar_resultado
  herramienta: read
  argumentos: README.md
```

Una **máquina de estados** tiene estados explícitos y reglas para pasar de uno a otro. Al reabrir,
el programa lee el último estado confirmado y sabe qué regla ejecutar.

```text
Petición admitida
       |
       v
[pending] -- reservar y guardar --> [running]
                                      |
                       +--------------+----------------+
                       |                               |
                       v                               v
              guardar nueva fase               guardar resultado
                       |                               |
                       v                               v
                siguiente paso                      [terminal]

Si el proceso desaparece durante running:
  reabrir -> reconciliar -> pending con el checkpoint conservado
```

Es un esquema de recuperación normal; también existen esperas de tareas hijas, cancelaciones y
trabajo que se abandona deliberadamente tras reiniciar.

**No se conserva mágicamente la pila de JavaScript.** Se conserva información suficiente para
volver a ejecutar la fase correcta. Un checkpoint de tarea y un checkpoint del WAL son conceptos
diferentes: uno guarda progreso del trabajo; el otro incorpora páginas a la base principal.

### Un ejemplo: «lee el README y resúmelo»

Recorrido simplificado, no una enumeración exacta de todos los commits internos:

```text
Usuario
  |
  v
COMMIT: admitir la submission y colocar o encolar el mensaje
  |
  +----> ahora se puede confirmar la recepción
  |
  v
Tarea de generación llama al modelo
  |
  v
COMMIT: respuesta del modelo con llamada a read + tarea de herramienta
  |
  v
COMMIT: intención de ejecutar read
  |
  v
Leer README.md
  |
  v
COMMIT: resultado de read + avance de la tarea
  |
  v
Siguiente generación produce el resumen
  |
  v
COMMIT: respuesta final + resolución de la submission
  |
  v
Publicar el estado confirmado
```

Si el mismo mensaje vuelve a llegar con el mismo `requestId` a la misma conversación, pi-durable
recupera la submission existente en vez de admitir otra. Si está ocupada, su inbox guarda las
peticiones pendientes; no dependen únicamente de una cola en RAM.

### Qué ocurre con el texto a medio generar

El progreso del modelo y de las herramientas se confirma por lotes, con intervalos de 100 ms por
defecto configurables. Lo que aún no se ha confirmado puede perderse; ese intervalo no debe
interpretarse como una garantía de tiempo real independiente de la latencia del almacenamiento.

Guardar texto parcial **no significa continuar la conexión al modelo desde el siguiente token**.
Una solicitud interrumpida puede necesitar repetirse y generar otro texto o costes adicionales.
Se recupera el trabajo desde sus checkpoints, no necesariamente el mismo intento de red.

### La interfaz es una vista, no el motor del agente

`viewState()` y `watch()` permiten leer un snapshot y recibir cambios confirmados. Una interfaz
puede reconectar sin haber presenciado cada evento del proceso anterior.

El watcher no es un archivo de auditoría infinito: si un consumidor se queda muy atrás, puede
recibir un snapshot nuevo en lugar de todos los cambios intermedios. La garantía importante es
**converger al estado confirmado**.

## 6. El límite inevitable: la base de datos no controla el mundo exterior

Supongamos que una herramienta cobra un pago:

```text
1. COMMIT intención: cobrar con clave pedido-123
2. API externa: pago realizado
3. COMMIT resultado: recibo 77
```

Si el proceso muere entre 2 y 3, la base sigue diciendo «hay una intención pendiente». No puede
saber por sí sola si el cobro ocurrió. Esta ventana existe aunque SQLite y la replicación funcionen
perfectamente.

Es el **sándwich de efectos**: intención persistente, efecto externo, resultado persistente.

Hay tres formas habituales de resolver la incertidumbre:

- **Repetir si es seguro.** Leer un archivo suele ser repetible, aunque su contenido podría cambiar.
- **Usar idempotencia.** Enviar la misma clave al proveedor para que repetir la petición no repita
  el efecto. La garantía depende también de ese proveedor y de cuánto tiempo conserve las claves.
- **No repetir automáticamente.** Informar de una interrupción y dejar que el agente o una persona
  decida cómo comprobar lo ocurrido.

En pi-durable, una herramienta interrumpida solo se reejecuta cuando su política permite replay
seguro; de lo contrario produce un resultado `interrupted`. Declarar `replay: "safe"` es una
responsabilidad del autor, **no una prueba automática de que el efecto sea idempotente**.

Deduplicar una submission no deduplica automáticamente sus efectos externos. «Al menos una vez +
idempotencia» puede evitar efectos repetidos dentro del alcance de esa idempotencia, pero no
constituye una garantía universal de «exactamente una vez».

## 7. Otra máquina debe tener los datos: replicación y quórums

Si todo lo anterior vive en un único disco y ese disco se pierde, también se pierde la recuperación.
**Replicar** significa guardar copias en otras máquinas.

Para confirmar una escritura podemos esperar a todas las copias, a ninguna o a un conjunto
suficiente. Este último se llama **quórum**.

Ejemplo: cinco réplicas y confirmación de tres.

```text
Escritura X ----> réplica A: recibida
             +-> réplica B: recibida       3 confirmaciones: quórum
             +-> réplica C: recibida
             +-> réplica D: sin respuesta
             +-> réplica E: sin respuesta
```

Dos mayorías de tres sobre cinco siempre comparten al menos una réplica. Esa intersección ayuda a
construir protocolos que no olviden escrituras confirmadas cuando cambia el escritor.

**Contar respuestas no basta:** el protocolo también debe ordenar escrituras, recuperar el estado
correcto e impedir que un escritor antiguo siga confirmando cambios. Y si no podemos alcanzar un
quórum, puede ser necesario dejar de aceptar escrituras para preservar la consistencia.

### El escritor zombi y el fencing

Imagina que A se queda aislada de la red. La plataforma arranca B, pensando que A murió. Luego A
vuelve y sigue trabajando. Si ambas escriben, tenemos *split brain*: dos dueños para el mismo estado.

**Fencing** significa impedir activamente las escrituras del dueño antiguo. Por ejemplo, el almacén
puede aceptar solo el número de generación actual y rechazar peticiones de generaciones anteriores.
No basta con pedirle amablemente a A que se pare.

Aquí encaja el **modelo de actor**: una identidad estable, como `telegram:123`, agrupa estado y
trabajo. La plataforma coordina quién es el dueño activo de esa identidad.

Un actor no implica que cualquier función asíncrona se ejecute entera sin intercalarse con otra.
El aislamiento de la identidad y la exclusión de transacciones son garantías distintas.

## 8. Cloudflare Durable Objects: SQLite local, durabilidad fuera de la máquina

Un Durable Object combina una identidad estable, ejecución de un solo hilo y almacenamiento
privado. En los objetos respaldados por SQLite, las consultas SQL se ejecutan junto al código y
la API `sql.exec()` es síncrona: no necesita un viaje a un servidor SQL externo por cada consulta.

### Qué hay debajo

La [arquitectura publicada por Cloudflare](https://blog.cloudflare.com/sqlite-in-durable-objects/)
describe este recorrido:

```text
Código del Durable Object
          |
          v
SQLite local -> WAL -> Storage Relay Service
                            |
                            +--> 5 followers; confirmar al recibir 3 respuestas
                            |
                            +--> lotes y snapshots en almacenamiento de objetos
```

El **Storage Relay Service (SRS)** intercepta escrituras a través de la VFS de SQLite, la capa que
SQLite usa para acceder a archivos. Envía cambios a cinco réplicas auxiliares, llamadas followers,
en centros de datos distintos y confirma al recibir respuesta de al menos tres.

En ese diseño, los cambios se agrupan para subirlos a almacenamiento de objetos, hasta 10 segundos
o 16 MB por lote. **No se espera ese lote para toda confirmación:** los followers cubren la ventana
anterior a su almacenamiento definitivo. Son detalles de implementación publicados, no parámetros
que nuestra aplicación deba asumir inmutables.

Para sustituir una instancia aislada, el protocolo puede ordenar a un quórum de followers que deje
de confirmar escrituras de la antigua. Así la nueva instancia puede tomar el relevo sin que la
anterior siga confirmando cambios.

### Output gates: no anunciar éxito antes de tiempo

El SQL puede terminar localmente mientras la persistencia distribuida sigue pendiente. Los
**output gates** retienen mensajes salientes hasta que las escrituras anteriores estén confirmadas.
Si una escritura falla, se reinicia el objeto y no se envían esas salidas como si hubiera tenido éxito.

Esto protege el orden «persistir antes de anunciar». **No convierte un pago o un envío a Telegram
en parte de la transacción SQLite:** sigue existiendo la ventana del sándwich de efectos.

### Input gates: protección frente a ciertas intercalaciones

Los **input gates** bloquean la entrega de ciertos eventos de entrada mientras hay operaciones de
almacenamiento en curso. La API SQL síncrona también evita introducir un `await` entre consultas.

Pero **un `await fetch(...)` arbitrario no bloquea toda la conversación automáticamente**. Otro
manejador puede ejecutarse mientras esperamos. Para agrupar cambios se utilizan las transacciones
y mecanismos de concurrencia de la plataforma, no la suposición de que «un actor lo serializa todo».

### Recuperar datos no es reanudar cualquier función

Si un objeto es desalojado, desaparecen sus variables y promesas. Al siguiente evento se crea una
instancia que puede abrir el mismo SQLite. Hace falta que el código reconstruya su trabajo:
pi-durable aporta los checkpoints; pikit aporta los wakeups y la llamada para continuar.

Cloudflare ofrece además recuperación a puntos de los últimos 30 días para SQLite. Se llama
*point-in-time recovery* (PITR), o recuperación a un punto en el tiempo. Un *bookmark* identifica una
posición recuperable. Restaurar la base no deshace mensajes, pagos u otros efectos externos ya
producidos.

## 9. Rivet: separar el worker del almacenamiento de las páginas

Rivet también ofrece actores con identidad, estado y un ciclo de vida que permite dormirlos y
volverlos a despertar. Sus workers ejecutan el código de los actores en Bun o Node.

El diseño de SQLite investigado para este proyecto utiliza una **VFS propia**. En lugar de depender
de un archivo SQLite duradero en el worker, las páginas se leen y se guardan a través del motor.

```text
Worker: código del actor + SQLite + cachés
                       |
                       v
                    VFS propia
                       |
                       v
          páginas modificadas -> deltas LTX
                       |
                       v
        Depot / UDB: almacenamiento autoritativo
```

Un **delta** describe un cambio, no necesariamente una copia completa. En cada commit, las páginas
modificadas se codifican en deltas LTX y se publican atómicamente junto al índice de páginas y la
nueva cabeza de la base. Depot organiza estos datos; UDB es la fuente de verdad.

La implementación estudiada usa `journal_mode = DELETE` y `locking_mode = EXCLUSIVE`, no un WAL
local como el de Cloudflare. La VFS y el almacén mantienen la atomicidad del commit. **WAL no es
sinónimo de toda arquitectura durable:** hay varias formas de conservar y ordenar cambios.

El motor incluye un mecanismo de compactación para agrupar deltas y reducir el coste de lectura.
También tiene primitivas internas para ramas, puntos de restauración y recuperación histórica.
Eso no demuestra que exista una API pública equivalente en RivetKit: en el código estudiado,
PITR está desactivado por defecto y la compactación también tiene una opción que la desactiva por
defecto. Hay que comprobar qué está habilitado y expuesto en cada despliegue, no asumir la
retención o las funciones de Cloudflare. El almacenamiento por niveles en S3 (*tiering*) descrito
para la edición Enterprise tampoco es una garantía del código abierto.

Los workers pueden tener cachés, pero no son la fuente de verdad. Si uno desaparece, otro puede
recuperar los datos del actor desde el motor. Como en Cloudflare, eso **no recupera por sí solo una
promesa JavaScript interrumpida**.

### «Self-hosted» no significa automáticamente «replicado»

En la versión de código abierto estudiada, UDB ofrece un backend de sistema de archivos sobre
RocksDB y otro de Postgres. Algunas notas internas aún nombran FoundationDB, pero no es un backend
expuesto por esa implementación: para esto manda el código de configuración.

Con el backend local, el motor sigue siendo un punto único de fallo. Con Postgres, la resistencia
efectiva depende de cómo se despliegue y replique esa base de datos. Postgres, por su nombre
solamente, no garantiza copias síncronas entre centros de datos.

`locking_mode = EXCLUSIVE` tampoco sustituye el protocolo de propiedad entre workers. Rivet usa su
planificador de actores, Pegboard, para la exclusión del actor; comprueba generaciones de ejecución y la cabeza
esperada de la base al aceptar escrituras. Probar el relevo de un worker caído y el rechazo de uno
antiguo sigue siendo parte de la validación pendiente de la integración de pikit.

Para pikit queda por implementar y probar la integración. Entre los límites del diseño investigado
está un máximo de **1.310.720 bytes de páginas modificadas por commit**. Habría que comprobar que
los commits reales, incluidos mensajes con imágenes, lo respeten.

## 10. Cómo encaja en pikit, y qué había antes

### Pi normal y pikit antiguo no eran exactamente lo mismo

El coding-agent de Pi guarda mensajes y otros registros de sesión en JSONL, pero guardar ese
historial no equivale al protocolo de tareas durables de pi-durable.

Sin embargo, sería incorrecto decir que **pikit antes no persistía nada ni podía reanudar**. Antes
de migrar a pi-durable, utilizaba `AgentHarness` de `pi-agent-core` 0.87–0.99 sobre sesiones
persistentes, con operaciones abiertas que podían retomarse.

El adaptador de pikit completaba garantías que faltaban:

- Una línea de promesas por conversación ordenaba admisiones y otras operaciones dentro del proceso.
- El `requestId` viajaba dentro de un mensaje `custom`; el adaptador buscaba duplicados en el inbox
  y el transcript porque reutilizar un `operationId` no bastaba para deduplicar.
- Encolaba antes de intentar arrancar una ejecución para evitar carreras entre «está ocupada» y
  «acaba de terminar».
- Un registro adicional, `submissions-sql`, permitía seguir admisiones y respuestas.

Esas garantías dependían de un solo dueño por conversación. La exclusión en RAM del adaptador no
protegía frente a dos procesos independientes usando el mismo almacenamiento.

Con pi-durable, la admisión, la deduplicación y las tareas forman parte del propio runtime. pikit
eliminó aquellos puentes y los proveedores de sesiones sustituidos. La
[nota de migración](../features/completed/pi-durable-migration.md) explica qué se movió y qué se mantuvo.

### Un proceso sigue siendo una opción válida

En `server`, pikit puede seguir ejecutando todas las conversaciones en un proceso, sobre un archivo
SQLite persistente. En Cloudflare usa un actor por conversación. **pi-durable no obliga a distribuir
el agente**: separa el trabajo persistente del proceso, independientemente de dónde se ejecute.

pi-durable 1.2.0 exige un solo proceso propietario por almacenamiento; no coordina varios Harness
escribiendo desde procesos distintos. Que SQLite tenga bloqueos no hace segura por sí sola esa
configuración: el Harness también mantiene coordinación e identificadores en memoria.

### La cadena completa de un mensaje

pikit añade garantías de entrada, activación y entrega alrededor del runtime:

```text
Telegram entrega una petición
             |
             v
Admitir en pi-durable con un requestId estable
             |
             v
Guardar el wakeup que impulsará el trabajo, si la plataforma lo necesita
             |
             v
Confirmar recepción a Telegram
             |
             v
Ejecutar / reabrir / reanudar desde checkpoints
             |
             v
Guardar la respuesta en el feed de respuestas
             |
             v
Entrega lee desde su cursor -> outbox / transporte -> Telegram
```

Un **cursor** guarda hasta qué posición de un feed ha avanzado un consumidor. Una **outbox** guarda
los envíos pendientes, para que un fallo del transporte no borre la intención de enviarlos.

Por eso la entrega no depende solo de escuchar un evento: un evento perdido no borra la fila del
feed. El consumidor puede encontrarla en el siguiente pase. Si el proceso cae después de enviar,
pero antes de guardar «enviado», un reintento puede duplicar el mensaje.

Hay otro requisito esencial: **tener trabajo persistente no significa que alguien lo esté ejecutando**.
En Cloudflare, pikit conserva wakeups sobre la alarma del objeto para volver a activarlo. En un
servidor, los timers en RAM se reconstruyen al arrancar a partir del estado persistente.
El [recorrido completo](message-flow.md) detalla estos pasos y sus ventanas de fallo.

## 11. Qué protege cada capa, y qué no

```text
pikit            admisión antes del ack + wakeups + feed/cursor + entrega
    |
pi-durable       submissions + fases + checkpoints + resultados confirmados
    |
SQLite           transacciones atómicas + recuperación local
    |
Plataforma       almacenamiento fuera del worker + propiedad del actor
    |
Operación        copias de seguridad + monitorización + pruebas de recuperación
```

| Situación | Protección y límite |
|---|---|
| El proceso cae entre fases | Checkpoints de pi-durable; hay que reabrir y activar el trabajo |
| La escritura se interrumpe | Atomicidad de SQLite y del backend; la durabilidad depende de la configuración |
| Se pierde la máquina | Solo se resiste con almacenamiento o copias fuera de ella |
| Telegram reenvía una petición | El mismo `requestId` deduplica la admisión en esa conversación |
| Una herramienta queda a medias | Replay seguro, idempotencia o resultado `interrupted`; no certeza automática sobre el efecto |
| Hay un escritor zombi | Se necesita coordinación de propiedad y fencing de plataforma |
| Se pierde un evento de respuesta | El feed persistente y el cursor permiten volver a encontrarla |
| No llegan más mensajes | Hace falta una alarma o mecanismo externo que despierte el trabajo pendiente |
| Un bug borra datos | Replicarlo replica también el error; hacen falta backups o historial recuperable |
| El proveedor externo rechaza permanentemente un envío | Los reintentos no lo arreglan; hay que registrar y comunicar el fallo |

Un error de almacenamiento es fatal para el Harness abierto: pi-durable no sigue publicando como
si hubiera guardado. Para recuperarse hay que reabrirlo sobre un almacén consistente. También hacen
falta el código y las extensiones adecuados; guardar una fase no garantiza que cualquier versión
futura sepa ejecutarla.

La arquitectura mejora la **seguridad** («no anunciar un estado inexistente») y permite recuperar el
trabajo. La **progresión** («acabará avanzando») exige además procesos activos, wakeups, proveedores
disponibles y políticas para los fallos definitivos. No promete terminar cualquier tarea bajo
cualquier fallo.

### Cuatro cosas que no conviene confundir

1. **Log de almacenamiento:** cómo guardamos y recuperamos bytes o páginas.
2. **Estado durable del agente:** qué tarea debe continuar y con qué checkpoint.
3. **Idempotencia externa:** cómo evitamos repetir efectos fuera de nuestra base.
4. **Recuperación histórica:** cómo volvemos a un estado anterior; no deshace el mundo exterior.

Y tres costes reales: confirmar cambios consume I/O y a veces red; los logs y las copias ocupan
espacio; recuperar puede repetir solicitudes externas, añadir latencia y generar gasto.

## 12. La explicación en treinta segundos

> Un log es una secuencia ordenada de registros que permite recuperar estado. SQLite utiliza un
> journal o un WAL para que los cambios sean atómicos. pi-durable guarda además las peticiones,
> las fases del agente y los resultados, para que un proceso nuevo sepa continuar el trabajo.
> Durable Objects y Rivet añaden identidad de actor y almacenamiento independiente del worker.
> Juntos permiten reconstruir el agente después de un fallo, sin confundir eso con que todos sus
> efectos externos ocurran exactamente una vez.

## Fuentes y siguientes lecturas

- [pi-durable 1.2.0: README](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/README.md)
  y [especificación](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/docs/spec.md):
  commits, tareas, replay, vistas y límites del almacenamiento.
- [Pi coding-agent: SessionManager](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/session-manager.ts):
  persistencia del historial JSONL, distinta del protocolo de tareas de pi-durable.
- [SQLite: Write-Ahead Logging](https://www.sqlite.org/wal.html): commits, checkpoints y sincronización.
- [Cloudflare: SQLite in Durable Objects](https://blog.cloudflare.com/sqlite-in-durable-objects/):
  arquitectura de SRS, followers, quórums y snapshots descrita en 2024.
- [Cloudflare: SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
  y [API de almacenamiento KV](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/):
  transacciones, recuperación, gates y opciones que modifican las garantías por defecto.
- [Rivet: Depot](https://github.com/rivet-dev/rivet/blob/aa8800b/docs-internal/engine/depot.md),
  [VFS de SQLite](https://github.com/rivet-dev/rivet/blob/aa8800b/docs-internal/engine/sqlite-vfs.md)
  y [límites](https://github.com/rivet-dev/rivet/blob/aa8800b/docs/actors/content/docs/limits.mdx):
  diseño de almacenamiento estudiado; la disponibilidad depende de versión y despliegue. Para
  contrastar notas internas, véanse los backends en
  [la configuración de UDB](https://github.com/rivet-dev/rivet/blob/aa8800b/engine/packages/config/src/config/db/mod.rs)
  y los valores por defecto de compactación y PITR en
  [la configuración de SQLite](https://github.com/rivet-dev/rivet/blob/aa8800b/engine/packages/config/src/config/sqlite.rs).
- En pikit: [targets](targets.md), [flujo de mensajes](message-flow.md),
  [migración a pi-durable](../features/completed/pi-durable-migration.md) y
  [propuesta de Rivet](../features/deployment-rivet.md).
