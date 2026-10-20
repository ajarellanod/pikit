# Composicion modular: plan de una sola ejecucion

**Estado:** plan; no implementado.

**Entrega:** una unica ejecucion coordinada con subagentes, un cambio integrado y una unica entrega. No hay fases funcionales, entregas parciales ni aprobaciones entre bloques. Las dependencias tecnicas y la verificacion final siguen existiendo: no se publican piezas incompletas.

## Objetivo y limites

La misma composicion debe recibir el mismo diagnostico desde el wizard, `new`, `add`, `remove`, `upgrade`, `ui`, `doctor` y las comprobaciones previas a arrancar. El wizard presenta alternativas y motivos; no mantiene una segunda implementacion de compatibilidad.

El caso que debe dejar de ser posible es un proyecto completo con `deployment-local` y `proposals-local`: ambos declaran `server`, pero el primero no ejecuta Compose ni el deployer que el segundo necesita.

Incluido en esta entrega:
- Requisitos de despliegue declarativos, inferencia desde `compose` y validacion compartida.
- Persistencia de esos datos y comprobacion de la composicion candidata antes de modificar archivos.
- Opciones incompatibles visibles pero no seleccionables en el wizard.
- Extraccion de las reglas de comportamiento por IDs de componentes en la creacion del proyecto.
- Politica explicita de permisos del steward en los presets.
- Descriptor del dashboard de cada registro, en lugar de una lista de componentes en la CLI.
- Pruebas negativas, un registro externo con nombres arbitrarios y documentacion coherente.

Fuera de esta entrega:
- Implementar el deployer nativo de launchd/systemd. La nueva validacion debe decir que no existe, no anunciarlo como soportado.
- Git/HTTP registries, namespaces de componentes, contract packages o presets que mezclen varios registros. Son el trabajo separado de `features/registries-plan.md`.
- Un motor de plugins, un DSL de condiciones, nuevos hooks arbitrarios de instalacion o un segundo runtime de agentes.
- Cambios a `@pikit/core`, sus exports, los dos targets o los protocolos de ejecucion de Pi.
- Modificar `techbot`, sus credenciales, datos, repositorio o servicios.
- Mezclar los cambios pendientes del installer/PATH o del dashboard/chat que ya existen en el checkout.

## Contrato comun fijado antes de repartir los archivos

### Requisitos de despliegue

Se amplian los manifiestos con esta forma, sin introducir objetos de infraestructura en el App:

```jsonc
// deployment-docker/component.json
"deployment": {
  "supports": ["services.compose", "proposals.deployer"]
}

// proposals-local/component.json
"requires": {
  "pikit": "<rango actual>",
  "contracts": "<rango actual>",
  "capabilities": [],
  "deployment": ["proposals.deployer"]
},
"compose": "compose.yaml"
```

Decisiones cerradas:
- `deployment.supports` solo lo declara un componente de kind `deployment`.
- `requires.deployment` puede aparecer en cualquier componente. Un despliegue no se satisface a si mismo con un requisito circular.
- Son conjuntos de nombres de protocolos/prestaciones, no nombres de componentes. Se valida formato, duplicados y estructura; no hay un enum cerrado de prestaciones en la CLI.
- `services.compose` significa que el despliegue aplica las contribuciones Compose registradas con el protocolo actual. Un campo `compose` implica ese requisito automaticamente. Declararlo tambien a mano es redundante y se rechaza.
- `proposals.deployer` significa que el despliegue puede activar el controlador del protocolo existente `@pikit/contracts/deployer`. No significa simplemente que hay un ejecutable llamado Docker.
- Docker declara ambas prestaciones. Local, Cloudflare y celld no declaran prestaciones que no implementan.
- Un registro externo puede usar una prestacion nueva con un nombre propio sin cambiar la CLI. Un requisito sin proveedor se diagnostica al componer; no se exige que su proveedor viva en ese mismo registro.
- Los rangos de versiones siguen siendo los existentes `requires.pikit/contracts/adapter`. No se construye otro resolvedor semver para etiquetas de despliegue.
- Los mismos datos se guardan en cada registro de componente instalado de `pikit.json`. La ausencia significa que el componente no declara prestaciones/requisitos; no se consultan IDs builtin para inventarlos.
- `upgrade` detecta cambios solo de metadatos, aunque la version textual siga siendo 0.0.1. Se actualizan registro, igualdad y normalizacion conjuntamente.
- No se agregan aliases, migraciones ni lectores especiales para formatos antiguos de 0.0.x.

Las declaraciones no prueban por si solas que un proveedor cumple el protocolo. Los checks del proveedor y la suite existente del deployer siguen siendo necesarios. Una fixture extranjera prueba extensibilidad de la CLI, no estabilidad de un nuevo proveedor real.

### Planificador puro

Archivo nuevo: `packages/cli/src/project/composition.ts`.

API que todos los autores usaran:

```ts
type DeploymentFacts = {
  name: string;
  compose?: string;
  deployment?: { supports: readonly string[] };
  requires?: { deployment?: readonly string[] };
};

type CompositionIssue = {
  code: "deployment_missing" | "deployment_ambiguous" | "deployment_requirement_unmet";
  component?: string;
  requirement?: string;
  deployment?: string;
  deployments?: readonly string[];
};

type CompositionPlan = {
  deployment?: string;
  issues: readonly CompositionIssue[];
};

planComposition(components: readonly DeploymentFacts[]): CompositionPlan;
introducedIssues(before: CompositionPlan, after: CompositionPlan): readonly CompositionIssue[];
formatCompositionIssue(issue: CompositionIssue): string;
```

Comportamiento:
- Usa `kindOf` para encontrar el despliegue. Se comparte esa seleccion con `deployment-module.ts`; no quedan dos reglas de cardinalidad.
- Cero despliegues es valido para un proyecto incompleto que no tenga requisitos de despliegue. Si algun componente necesita prestaciones, se devuelve `deployment_missing`; nunca se interpreta como requisito satisfecho.
- Mas de un despliegue produce `deployment_ambiguous`. No se unen sus prestaciones.
- Se comprueba cada requisito contra el unico despliegue seleccionado.
- Las entradas y los diagnosticos se normalizan para que su identidad y orden sean deterministas. Un requisito se identifica por consumidor y protocolo, no por la redaccion del error.
- No lee archivos, importa componentes, hace peticiones, ejecuta Docker ni arranca Apps.
- No sustituye la resolucion de capabilities de runtime: reutiliza los checks existentes, que siguen siendo por App y basados en la composicion real.
- Coste lineal en componentes y requisitos, usando sets. Sin backtracking ni solver general.

Politica de operaciones:
- `new` valida el conjunto completo, incluidas offers, UI, features y eleccion de despliegue, antes de crear el directorio.
- `add` y `upgrade` validan el borrador completo antes de confirmar y antes de aplicar. `upgrade --dry-run` diagnostica igualmente.
- `remove` comprueba el conjunto restante y no puede introducir dependencias insatisfechas. Para cambiar un despliegue se retiran antes sus dependientes; no se introduce un comando `swap` en este trabajo.
- Se permiten operaciones de reparacion sobre un proyecto ya incorrecto cuando no introducen nuevas obligaciones incumplidas. El estado restante sigue apareciendo como incorrecto en doctor; nunca se imprime green por el mero hecho de que la mutacion haya terminado.
- `--force` conserva su significado actual para archivos/rangos donde ya se permite; no hace ejecutable una composicion nueva imposible.
- Los consumidores de los registros instalados funcionan sin tener disponible el registro original.
- El rechazo no modifica fuentes, config, manifest, lockfile, bases ni vendor, y no ejecuta hooks, instalaciones o despliegues. Las confirmaciones no constituyen permiso para saltarse esta validacion.

### Contexto de doctor

Se amplian `DoctorOptions` y el IO estructural del hook con `operation: "doctor" | "dev" | "up"`. El comando publico `doctor` usa `doctor`; `checkReady` transmite el modo correspondiente a su proceso hijo. No se agrega un flag publico nuevo por esto.

La composicion declarativa se comprueba antes de los hooks. Una composicion local incompatible no debe llegar a ejecutar Docker para descubrirlo.

En un proyecto Docker valido, `dev` no arranca el sidecar: proposals-local informa que la aplicacion de propuestas no esta activa en ese modo, sin hacer la comprobacion de un despliegue que no esta ocurriendo. Para `doctor/up` conserva sus comprobaciones de Compose. Se mantiene la nota de seguridad de execution-local. No se cambia el gate de aprobacion ni se hace pasar una propuesta por desplegada.

## Politica de creacion propiedad del preset

No se concede una herramienta porque un componente la pida. Los permisos del agente pertenecen al preset elegido y, despues de crearlo, al codigo del proyecto.

Se normaliza `features` a una sola forma de objeto y se actualizan todos los presets y fixtures de esta entrega. No se mantienen las formas antiguas como capa de compatibilidad.

```yaml
steward:
  tools: [read, write, edit, fetch, websearch]
  extensions: [pikit-self]

config:
  router-basic:
    defaultAgent: steward

agents:
  folders:
    feature: agents-folders
    command: agents

features:
  - components: [agents-folders]
  - components: [admin-proposals, proposals-local]
    ui: true
    steward:
      tools: [bash]
```

Semantica:
- `steward.tools/extensions` son listas explicitas. Los presets durable incluyen bash cuando procede. Un proveedor de herramientas instalado, incluso con un nombre diferente a bash, no obtiene permisos por su mera presencia.
- Se eliminan `NAMED_FOR`, `STARTER_EXTENSIONS` y `NOT_NAMED` como decisiones internas de la CLI. La union de permisos solo considera el preset y las features efectivamente elegidas.
- Los permisos adicionales se muestran en el hint/resumen antes de aceptar la feature. En modo no interactivo, elegir el preset/feature mediante los argumentos es la decision explicita.
- Solo se aplica al steward inicial en `new`; `add`, `upgrade` y `ui on` no reescriben los permisos de agentes existentes.
- Se validan las claves de herramientas y extensiones contra la descripcion de la composicion candidata, con setup sin start, no solo contra la presencia del nombre generico `agent.tool` en un manifesto. Se reutilizan los helpers de descripcion existentes.
- `config` expresa valores del proyecto, no codigo ni plantillas ejecutables. Sus entradas corresponden a componentes conocidos del preset/alternativas y solo se aplican a los seleccionados. Sus valores pasan el esquema real del componente. Sustituye el default de router-basic en `STARTER_CONFIG`.
- `ui: true` en una feature conserva la comodidad actual de creacion, pero deja de depender de `NEEDS_DASHBOARD`. No transforma un componente admin en una dependencia dura de una UI: su API puede seguir usandose sin dashboard.
- `agents.folders` mantiene la pregunta uno/varios con una feature y un comando declarados por el preset. La CLI no reconoce el ID agents-folders.
- El layout de archivos de agentes sigue siendo el formato existente del starter. Solo se ejecuta el comando declarado por el proveedor elegido, mediante `installedCommand/runComponentCommand`, despues de instalar y antes de doctor. No hay hooks de creacion arbitrarios.
- Se valida antes de escribir que la feature de carpetas existe, que su comando esta declarado y que no hay ambiguedad. El README usa ese comando, no una cadena builtin.
- Pueden permanecer tablas puramente cosmeticas con fallback generico a titulo/nombre. El criterio es que una coincidencia de ID no decida permisos, compatibilidad, defaults o ejecucion de comandos.

La resolucion del preset se implementa una sola vez en el nuevo `project/preset-plan.ts`:

```ts
resolvePresetPlan(registry, { preset, targets, choices, ui }): Promise<ResolvedPresetPlan>;
```

`ResolvedPresetPlan` devuelve `components`, `config`, `ui`, `steward`, `agents`, las features con `available` y `issues`, y el `CompositionPlan`. El wizard lo llama al cambiar elecciones y `new` lo llama con los argumentos definitivos; registry validate usa la misma funcion para sus casos. Este helper coordina la lectura del preset, offers y descriptor; no contiene otra implementacion de las reglas de despliegue, que siempre llama en `planComposition`. La descripcion de setup para validar permisos no ejecuta start.

## Dashboard de cada registro

Archivo nuevo: `registry/dashboard/dashboard.json`. El esquema y su lector viven en `packages/cli/src/project/dashboard-manifest.ts`.

```json
{
  "components": ["admin-auth-token", "admin-api", "settings-store"],
  "defaultFor": {
    "admin-auth-token": "admin.auth",
    "settings-store": "settings"
  }
}
```

- Sustituye `UI_COMPONENTS` y `UI_DEFAULT_FOR`. Los nombres concretos quedan como politica del dashboard de ese registro.
- Se reutiliza la comprobacion actual de proveedores por App: un auth/settings alternativo presente en todas las Apps conserva su lugar; una satisfaccion parcial o desconocida no se adivina.
- El descriptor no permite un default que no provee la capability indicada, componentes ausentes o incompatibles con el target.
- `new --ui`, features con UI y `ui on` consumen el mismo descriptor y el mismo plan de componentes resultante.
- `ui off` conserva el seguimiento de ownership actual: no elimina proveedores del usuario ni depende de recuperar el registro para saber que instalo.
- Esto no agrega composicion entre registros: el dashboard y sus defaults proceden del registro elegido, como hoy.

## Integracion que no puede faltar

| Superficie | Cambio obligatorio |
|---|---|
| `registry/manifest.ts` | Campos, validacion estructural, normalizacion y descripcion del protocolo Compose sin hardcodear el proveedor. |
| `project/pikit-json.ts` | Persistir los datos de composicion; que remove/doctor no necesiten el registro. |
| `commands/add.ts` | `recordInstall`, planning del conjunto completo y verificacion despues de resolver offers, antes de writes. |
| `commands/remove.ts` | Validar las obligaciones del conjunto restante y permitir reparar un estado incorrecto sin omitir diagnosticos. |
| `commands/upgrade.ts` | Preflight de todo lo solicitado, dry-run, deriva de metadatos en sameInstall y aplicacion transaccional. |
| `commands/new.ts` | Validar antes de mkdir, resolver politica de preset/UI y generar el layout sin IDs de componentes. |
| `commands/wizard.ts` y `src/ui.ts` | Opciones con motivo de indisponibilidad; reevaluar con las decisiones actuales; no elegir otro despliegue por el usuario. |
| `project/registry-source.ts` | Esquema canonico de presets, permisos, config, agentes y features; no filtrar solo por target. |
| `commands/starter.ts` | Recibir permisos, config, layout y comandos resueltos. No decidirlos por nombres de componentes. |
| `commands/ui.ts` y `project/dashboard.ts` | Descriptor por registro y seleccion por capacidades, sin duplicar el resolver existente. |
| `commands/doctor.ts`, `commands/deployment.ts`, `project/component-doctor.ts` | Diagnostico previo a hooks y contexto de operacion. No agregar otro campo de error paralelo si basta `problems` del report actual. |
| `project/deployment-module.ts` | Compartir la seleccion de un solo despliegue con el planificador. |
| `registry/commands.ts` | Validar metadatos, descriptor, politica y combinaciones de alternativas de despliegue con features; no solo cada opcion por separado. |
| Componentes | Declarar solo prestaciones reales; doctor de proposals-local coherente con dev/up. Los guards internos de proveedores permanecen como defensa en profundidad sin importar la CLI desde sus fuentes. |
| Generados | Regenerar schemas e indice con el comando del repo; no editarlos a mano en paralelo. |

El rechazo de una feature incompatible no invalida todo un preset que ofrece alternativas. Registry validate comprueba que el preset base es valido, que las opciones anunciadas como disponibles lo son y que las no disponibles tienen un diagnostico. Un `--with` explicito incompatible falla, no desaparece de la seleccion silenciosamente.

## Reparto de subagentes en la misma ejecucion

El coordinador crea un worktree de integracion real fuera de /tmp, con el HEAD capturado al comenzar. Todos los autores trabajan alli con ownership de archivos disjunto y rutas absolutas. Esto separa el encargo de los cambios ajenos que ya hay en el checkout. No se copia ni se carga ningun .env real. Se instala con el lockfile del repositorio.

No se deja que ocho agentes editen la misma rama y los mismos archivos sin ownership. Cualquier ajuste en archivos de otro autor se solicita al propietario; no se escribe por fuera de su lista.

| Subagente | Responsabilidad y archivos propios |
|---|---|
| A - Contrato y planificador | `registry/manifest.ts`, `project/pikit-json.ts`, nuevos `project/composition.ts` y su test, tests de manifest/pikit-json. Entrega las interfaces exactas fijadas arriba. |
| B - Transacciones | `commands/add.ts`, `remove.ts`, `upgrade.ts`, sus tests y tests nuevos de mutaciones de composicion. No modifica el esquema compartido. |
| C - Wizard y creacion | `commands/new.ts`, `starter.ts`, `wizard.ts`, `project/registry-source.ts`, nuevo `project/preset-plan.ts`, `src/ui.ts`; sus tests y E2E del wizard. Consume el descriptor del autor D. |
| D - Descriptor de dashboard | `commands/ui.ts`, `project/dashboard.ts`, nuevo `project/dashboard-manifest.ts`, `registry/dashboard/dashboard.json`, tests de UI/descriptor. No modifica archivos visuales del dashboard/chat. |
| E - Doctor y arranque | `commands/doctor.ts`, `commands/deployment.ts`, `project/component-doctor.ts`, `project/deployment-module.ts`, hook y tests doctor de proposals-local y tests correspondientes de CLI. |
| F - Datos oficiales | Manifiestos afectados y presets YAML canonicos. Las fixtures existentes las adapta el propietario de su archivo de test. No edita schemas o indice generados ni codigo de otros autores. |
| G - Validacion y adversarial | `registry/commands.ts`, checks de registro necesarios, nuevo helper `testing/composition-registry.ts`, pruebas nuevas de matriz y registro externo bajo rutas nuevas propias. No parchea la implementacion de los otros autores para hacer pasar sus tests. |
| H - Documentacion | SPEC, docs/components.md, docs/contracts.md, docs/cli.md, docs/dashboard.md, notas de deployment-local/cli-features, referencias de la skill y READMEs afectados. Trabaja en el worktree aislado. Los conflictos con documentacion pendiente del checkout principal se integran preservando ambos trabajos antes de entregar; no se difieren a otra entrega. No modifica fuentes visuales del dashboard/chat. |

Las firmas, nombres y reglas de este documento son el contrato de trabajo de todos los autores: ninguno inventa otra API durante la ejecucion. El coordinador resuelve divergencias dentro del mismo encargo, integra los cambios, ejecuta la generacion una sola vez y revisa el diff real. No hay aprobaciones funcionales entre autores.

Un revisor independiente de solo lectura examina el diff integrado y los resultados de las pruebas; intenta encontrar decisiones por ID, permisos implicitos, checks omitidos y escrituras antes del rechazo. Sus hallazgos se corrigen por el propietario del archivo dentro de esa misma ejecucion. La verificacion final no es una segunda entrega.

## Matriz obligatoria de pruebas

1. **Caso real:** local + proposals-local y local + expose-cloudflare-tunnel se anuncian como no disponibles; seleccionarlos por flags falla antes de crear archivos y antes de OAuth. Docker + propuestas sigue siendo valido.
2. **Registro externo:** hosts y consumidores con nombres arbitrarios. Incluye una prestacion propia desconocida por el kit, por ejemplo `acme.review-host`, para demostrar que no existe un enum builtin cerrado.
3. **Proveedor seleccionado:** dos despliegues no pueden satisfacer una feature sumando sus prestaciones; es un error de ambiguedad.
4. **Operaciones directas:** new, add, remove y upgrade dan los mismos codigos/obligaciones que el wizard. Un rechazo conserva byte a byte config, manifest, package, lockfile, bases y vendor, y no llama hooks ni bun install.
5. **Upgrade:** un proveedor que pierde una prestacion bloquea el cambio; metadatos modificados sin incremento textual de version se detectan; dry-run no escribe. Una actualizacion de varios componentes se comprueba como conjunto, no contra estados intermedios ficticios.
6. **Reparacion:** retirar un consumidor incompatible o resolver una duplicidad permite corregir el proyecto; no se ocultan los problemas que permanezcan. Retirar el unico proveedor que necesita otro introduce error y se rechaza.
7. **Sin registro:** doctor/remove pueden comprobar obligaciones con solo pikit.json y las fuentes instaladas.
8. **Modos:** un proyecto local incompatible falla antes de Docker; un Docker valido en dev no aplica propuestas ni arranca sidecars y lo comunica. Doctor/up mantienen los checks reales de su operacion.
9. **Permisos:** una herramienta externa de shell con otro nombre no se concede por instalarla. Un componente no puede conceder tools/extensions mediante campos desconocidos. Solo el preset y las features seleccionadas conceden claves existentes al steward inicial; nunca a agentes existentes durante add/upgrade.
10. **Carpetas:** un proveedor de catalogo con otro nombre y otro comando conserva la pregunta y genera los archivos. Un comando no declarado o ambiguo falla antes de writes. No se ejecutan comandos ajenos.
11. **Dashboard:** nombres externos en descriptor, auth/settings alternativos, composicion desconocida, satisfaccion parcial y Worker/object. UI off conserva proveedores preexistentes y los datos.
12. **Aliases/config:** aliases heredan la politica, alternativas de router reciben solo su config y defaults, una feature no elegida no aporta UI, permisos ni comandos.
13. **Prueba de sensibilidad:** en copias temporales aisladas, romper seleccion unica, inferencia Compose o persistencia de requisitos debe hacer fallar sus casos especificos. Cambiar solo el nombre de proveedores/consumidores no cambia la compatibilidad.
14. **Regresion:** presets oficiales, dos Apps durable, add/remove/upgrade, instalador y wizard siguen pasando. No se tocan credenciales reales ni servicios del usuario.

No basta que las fixtures de los tests se ajusten todas mediante overrides que omitan la garantia. Las pruebas independientes llaman la interfaz publica y comprueban efectos y ausencias de efectos.

## Verificacion y cierre del unico encargo

En el worktree integrado:

```sh
bun run registry generate
bun run registry validate
bun run typecheck
bun run lint
perl -e 'alarm 180; exec @ARGV' bun test packages/cli/src/project/composition.test.ts
perl -e 'alarm 600; exec @ARGV' bun test
PIKIT_E2E=1 perl -e 'alarm 300; exec @ARGV' bun test packages/cli/src/e2e-wizard.test.ts
PIKIT_INSTALLER_TEST=1 perl -e 'alarm 180; exec @ARGV' bun test installer/install.test.ts
perl -e 'alarm 300; exec @ARGV' bun run test:workerd
git diff --check
```

Tambien se ejecutan los tests nuevos de transacciones y registro externo por sus rutas definitivas. Los procesos largos usan spawn asincrono; no se introduce el spawnSync que puede colgar Bun 1.4.x. No se carga .env real para hacer pasar fixtures.

Un timeout o una suite incompleta no se informa como exito. Si aparece un fallo ajeno, se contrasta con el mismo baseline limpio y se documenta; no se arregla por accidente otra funcionalidad para conseguir un verde aparente. Los checks que precisan herramientas no disponibles se enumeran como cobertura pendiente, no como pruebas pasadas.

Criterios de aceptacion del conjunto:
- Ninguna decision de compatibilidad o permiso depende de los IDs builtin afectados.
- Una composicion invalida se detecta antes de modificar el proyecto.
- Se preservan los checks de runtime, separacion por App, aprobacion y recuperacion existentes.
- El caso techbot se reproduce como fixture y recibe un motivo util, no un error de archivo Compose ausente.
- Metadatos, persistencia, validacion, wizard, comandos directos, schemas, registro y documentacion se entregan juntos.
- El diff no contiene cambios de core, deployer nativo, proyectos reales, datos o credenciales ni trabajo ajeno.

La entrega final incluye resumen de archivos, decisiones, pruebas ejecutadas y cobertura pendiente. El commit usa paths explicitos y se revisa el staged diff. Publicar en main no se confunde con escribir el plan: solo se hace cuando la orden de ejecucion incluya publicarlo.
