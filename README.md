# Exposición de Servicios y Configuración Segura en Minikube

## 1. Introducción y objetivos

Este proyecto despliega en Minikube una arquitectura de **dos capas**: un *backend* HTTP (Node.js/Express) y una base de datos **MongoDB**. La configuración de la aplicación se desacopla del código mediante un **ConfigMap** (datos públicos) y un **Secret** (credenciales en Base64). Solo el backend se publica hacia el exterior, mediante un Service **NodePort**; MongoDB permanece privada tras un Service **ClusterIP**.

### Objetivos de aprendizaje

| # | Objetivo | Dónde se cumple |
|---|----------|-----------------|
| 1 | Diseñar y desplegar una arquitectura de dos capas (API + MongoDB) | `03-mongo-stack.yaml`, `04-backend-stack.yaml` |
| 2 | Desacoplar la configuración no sensible con ConfigMaps | `01-app-configmap.yaml` |
| 3 | Proteger credenciales con Secrets | `02-db-secret.yaml` |
| 4 | Exponer la aplicación con un Service NodePort | `backend-service` en `04-backend-stack.yaml` |

### Estructura del repositorio

```text
/
├── k8s/
│   ├── 01-app-configmap.yaml   # ConfigMap: DB_HOST, DB_NAME, APP_PORT
│   ├── 02-db-secret.yaml       # Secret Opaque (Base64): DB_USER, DB_PASS
│   ├── 03-mongo-stack.yaml     # PVC + Deployment MongoDB + Service ClusterIP
│   └── 04-backend-stack.yaml   # Deployment backend (envFrom) + Service NodePort
├── README.md
└── src/                        # Código fuente del backend
    ├── server.js
    ├── package.json
    ├── package-lock.json
    ├── Dockerfile
    └── .dockerignore
```

---

## 2. Justificación técnica: ConfigMap vs. Secret

| Aspecto | ConfigMap (`app-config`) | Secret (`db-secret`) |
|---------|--------------------------|----------------------|
| Contenido | `DB_HOST`, `DB_NAME`, `APP_PORT` | `DB_USER`, `DB_PASS` |
| Sensibilidad | Pública (puede estar en Git sin riesgo) | Confidencial |
| Formato | Texto plano | Base64 (`type: Opaque`) |
| Control de acceso | RBAC común | RBAC más restrictivo y auditable |
| Visibilidad en la CLI | `kubectl describe` muestra los valores | `kubectl describe` **oculta** los valores |

### Por qué separar

1. **Desacoplamiento (12-Factor, factor III).** La misma imagen de contenedor funciona en desarrollo, pruebas y producción; solo cambian el ConfigMap y el Secret. No se recompila para cambiar un puerto o un host.
2. **Principio de menor privilegio.** Se puede permitir que un desarrollador lea ConfigMaps (para depurar) sin darle acceso a Secrets. Con RBAC, el acceso a credenciales se concede a pocas identidades y se audita.
3. **Reducción de la superficie de exposición.** Kubernetes trata los Secrets con más cuidado: no se imprimen en `describe`, pueden montarse en `tmpfs` (memoria) cuando se usan como volumen y admiten cifrado en reposo en etcd.
4. **Ciclo de vida independiente.** Rotar la contraseña de la BD implica modificar solo el Secret; cambiar el nombre de la base de datos, solo el ConfigMap.
5. **Fuente única de verdad.** MongoDB y el backend leen `DB_USER`, `DB_PASS` y `DB_NAME` de los mismos recursos, por lo que no pueden quedar desincronizados.


---

## 3. Diagrama de arquitectura

```text
                      ┌─────────────────────────────────────────────────────────────┐
                      │  MINIKUBE  (nodo único, ej. IP 192.168.49.2)                │
                      │                                                             │
   Navegador /        │   ┌───────────────  Namespace: practica-s08  ────────────┐  │
   curl               │   │                                                      │  │
       │              │   │   ┌────────────────────┐   ┌────────────────────┐    │  │
       │  HTTP        │   │   │ ConfigMap app-config│   │ Secret db-secret   │    │  │
       │  :30080      │   │   │ DB_HOST=mongo-service│  │ DB_USER (Base64)   │    │  │
       ▼              │   │   │ DB_NAME=practica_s08_db│ │ DB_PASS (Base64)  │    │  │
 ┌──────────────┐     │   │   │ APP_PORT=3000      │   └─────────┬──────────┘    │  │
 │ <IP>:30080   │─────┼──▶│   └─────────┬──────────┘             │               │  │
 └──────────────┘     │   │             │ envFrom                │ envFrom       │  │
                      │   │             ▼                        ▼               │  │
                      │   │  ┌──────────────────────────────────────────────┐    │  │
                      │   │  │ Service backend-service  (NodePort 30080→80) │    │  │
                      │   │  └───────────────────┬──────────────────────────┘    │  │
                      │   │                      │ balancea (targetPort 3000)    │  │
                      │   │        ┌─────────────┴─────────────┐                 │  │
                      │   │        ▼                           ▼                 │  │
                      │   │  ┌───────────┐               ┌───────────┐           │  │
                      │   │  │ Pod       │               │ Pod       │  BACKEND  │  │
                      │   │  │ backend-1 │               │ backend-2 │  (Node.js)│  │
                      │   │  └─────┬─────┘               └─────┬─────┘           │  │
                      │   │        └──────────────┬────────────┘                 │  │
                      │   │                       │ mongodb://mongo-service:27017│  │
                      │   │                       ▼  (DNS interno de CoreDNS)    │  │
                      │   │  ┌──────────────────────────────────────────────┐    │  │
                      │   │  │ Service mongo-service  (ClusterIP 27017)     │    │  │
                      │   │  │  ⛔ NO accesible desde fuera del clúster      │    │  │
                      │   │  └───────────────────┬──────────────────────────┘    │  │
                      │   │                      ▼                               │  │
                      │   │  ┌──────────────────────────────────────────────┐    │  │
                      │   │  │ Pod mongo (MONGO_INITDB_* ← Secret/ConfigMap)│    │  │
                      │   │  │ Volumen ← PVC mongo-pvc (1Gi)                │    │  │
                      │   │  └──────────────────────────────────────────────┘    │  │
                      │   └──────────────────────────────────────────────────────┘  │
                      └─────────────────────────────────────────────────────────────┘
```

**Flujo:** el cliente llega al nodo por el NodePort `30080` → el Service `backend-service` reenvía al puerto `3000` de un Pod del backend → el backend lee sus variables (inyectadas con `envFrom`) y se conecta a `mongo-service:27017` por DNS interno → el Service `ClusterIP` lo dirige al Pod de MongoDB.

---

## 4. Requisitos previos

- Docker (o el driver de Minikube que uses), `minikube` y `kubectl` instalados.
- Minikube iniciado: `minikube start`.
- Verificación rápida: `kubectl get nodes` debe mostrar el nodo `minikube` en `Ready`.

---

## 5. Instrucciones de despliegue (paso a paso)

Ejecutar desde la raíz del repositorio.

### Paso 0 · Construir la imagen dentro de Minikube

La imagen se construye con el Docker **de Minikube** para que el clúster la encuentre sin registro externo (`imagePullPolicy: Never`).

```bash
# Linux / macOS / Git Bash
eval $(minikube docker-env)

# Windows PowerShell
# minikube docker-env | Invoke-Expression

docker build -t backend-s08:1.0 ./src
docker images | grep backend-s08      # (PowerShell: docker images | findstr backend-s08)
```

> Alternativa sin cambiar de entorno Docker: `docker build -t backend-s08:1.0 ./src && minikube image load backend-s08:1.0`

### Paso 1 · Crear el namespace

```bash
kubectl create namespace practica-s08
kubectl get namespace practica-s08
```

### Paso 2 · Aplicar los manifiestos en orden numérico

```bash
kubectl apply -f k8s/01-app-configmap.yaml
kubectl apply -f k8s/02-db-secret.yaml
kubectl apply -f k8s/03-mongo-stack.yaml
kubectl apply -f k8s/04-backend-stack.yaml
```

El orden importa: ConfigMap y Secret deben existir **antes** de los Pods que los referencian. (También funciona `kubectl apply -f k8s/`, que aplica en orden alfabético.)

### Paso 3 · Esperar a que los Pods estén listos

```bash
kubectl rollout status deployment/mongo-deployment   -n practica-s08
kubectl rollout status deployment/backend-deployment -n practica-s08
kubectl get pods -n practica-s08 -w                  # Ctrl+C para salir
```

### Paso 4 · Verificar el estado de los recursos

```bash
kubectl get pods,svc,configmaps,secrets -n practica-s08
```

Resultado esperado (los nombres de Pods varían):

```text
NAME                                      READY   STATUS    RESTARTS   AGE
pod/backend-deployment-xxxxxxxxxx-aaaaa   1/1     Running   0          1m
pod/backend-deployment-xxxxxxxxxx-bbbbb   1/1     Running   0          1m
pod/mongo-deployment-xxxxxxxxxx-ccccc     1/1     Running   0          2m

NAME                      TYPE        CLUSTER-IP      PORT(S)        AGE
service/backend-service   NodePort    10.x.x.x        80:30080/TCP   1m
service/mongo-service     ClusterIP   10.x.x.x        27017/TCP      2m

NAME                         DATA   AGE
configmap/app-config         3      3m

NAME                TYPE     DATA   AGE
secret/db-secret    Opaque   2      3m
```

### Paso 5 · Validar la inyección de variables

```bash
# Guardar el nombre de un Pod del backend
POD=$(kubectl get pods -n practica-s08 -l app.kubernetes.io/name=backend -o jsonpath='{.items[0].metadata.name}')

# Comando de la rúbrica (interactivo, lista todo el entorno)
kubectl exec -it $POD -n practica-s08 -- env

# Versión filtrada para la captura (solo las 5 variables del proyecto)
kubectl exec -it $POD -n practica-s08 -- env | grep -E '^(DB_HOST|DB_NAME|APP_PORT|DB_USER|DB_PASS)='
```

Salida esperada:

```text
DB_HOST=mongo-service
DB_NAME=practica_s08_db
APP_PORT=3000
DB_USER=admin_s08
DB_PASS=Pr4ct1ca_S08_2026
```

Esto demuestra que Kubernetes **decodificó** el Base64 del Secret y lo entregó como variable de entorno al proceso.

Comprobación del Base64 almacenado (opcional, útil para el informe):

```bash
kubectl get secret db-secret -n practica-s08 -o yaml           # valores aparecen codificados
kubectl get secret db-secret -n practica-s08 -o jsonpath='{.data.DB_USER}' | base64 -d
kubectl describe secret db-secret -n practica-s08              # solo muestra tamaños en bytes
```

### Paso 6 · Obtener la URL externa y probar

```bash
minikube service backend-service -n practica-s08 --url
```

Devuelve algo como `http://192.168.49.2:30080`.

> **Driver Docker en Windows/macOS:** el comando puede quedarse en ejecución y mostrar una URL tipo `http://127.0.0.1:XXXXX`. Es normal: **deja esa terminal abierta** y usa la URL en el navegador desde otra.

Pruebas (sustituye `<URL>` por la obtenida):

```bash
curl <URL>/                 # información del servicio
curl <URL>/health           # estado de la BD + confirmación de variables
curl <URL>/api/visits       # escribe/lee en MongoDB (el contador sube en cada llamada)
```

Respuesta esperada de `/health` (HTTP 200):

```json
{
  "status": "UP",
  "pod": "backend-deployment-xxxxxxxxxx-aaaaa",
  "configuration": {
    "allVariablesLoaded": true,
    "missing": [],
    "variables": {
      "DB_HOST":  { "loaded": true, "source": "ConfigMap (app-config)", "value": "mongo-service" },
      "DB_NAME":  { "loaded": true, "source": "ConfigMap (app-config)", "value": "practica_s08_db" },
      "APP_PORT": { "loaded": true, "source": "ConfigMap (app-config)", "value": "3000" },
      "DB_USER":  { "loaded": true, "source": "Secret (db-secret)",    "value": "********" },
      "DB_PASS":  { "loaded": true, "source": "Secret (db-secret)",    "value": "********" }
    }
  },
  "database": { "host": "mongo-service", "name": "practica_s08_db", "connected": true, "lastError": null }
}
```

El backend **enmascara** las credenciales en la respuesta HTTP: confirma que se cargaron sin exponerlas.

### Paso 7 · Comprobar que MongoDB no es accesible desde fuera

```bash
kubectl get svc mongo-service -n practica-s08    # TYPE=ClusterIP y sin EXTERNAL-IP ni NodePort
```

### Limpieza

```bash
kubectl delete namespace practica-s08            # elimina todos los recursos del laboratorio
```

---

## 6. Detalles de implementación

- **Inyección con `envFrom`:** el Deployment del backend referencia `configMapRef: app-config` y `secretRef: db-secret`; cada clave se convierte en una variable de entorno con el mismo nombre.
- **MongoDB y el Secret:** la imagen oficial usa `MONGO_INITDB_ROOT_USERNAME/PASSWORD` (vía `secretKeyRef`) para crear el usuario root al inicializar un volumen vacío; así el backend y la base de datos comparten las mismas credenciales sin duplicarlas.
- **Persistencia:** un `PersistentVolumeClaim` de 1 Gi conserva los datos si el Pod se reinicia. Con `strategy: Recreate` se evita que dos Pods compitan por un volumen `ReadWriteOnce`.
- **Sondas (probes):** `/health` (readiness) depende de MongoDB: si la BD cae, el Pod deja de recibir tráfico. `/live` (liveness) no depende de la BD, para no provocar reinicios en cascada.
- **Resiliencia:** el backend reintenta la conexión a MongoDB con *backoff*, por lo que no falla si arranca antes que la base de datos.
- **Seguridad del contenedor:** corre como usuario no root (UID 1000) y con `allowPrivilegeEscalation: false`.
- **Acoplamiento a respetar:** `APP_PORT` (ConfigMap) = `containerPort` = `targetPort` (puerto 3000). Si cambias uno, cambia los demás.
- **Limitación conocida:** una contraseña con `@`, `:` o `/` es válida porque el código aplica `encodeURIComponent` al construir la URI.

---

## 7. Solución de problemas

| Síntoma | Causa probable | Solución |
|---------|----------------|----------|
| Pod backend en `ErrImageNeverPull` | La imagen no está en el Docker de Minikube | Repetir el Paso 0 (`eval $(minikube docker-env)` antes de `docker build`) |
| `CreateContainerConfigError` | ConfigMap o Secret inexistente | Aplicar `01` y `02` antes; revisar con `kubectl describe pod` |
| Backend `Running` pero `0/1 READY` | MongoDB aún no está lista o credenciales incorrectas | `kubectl logs deploy/backend-deployment -n practica-s08` |
| `/health` → 503 con `Authentication failed` | El volumen de Mongo ya se inicializó con otras credenciales | `kubectl delete namespace practica-s08` y desplegar de nuevo (se borra el PVC) |
| `minikube service --url` se queda "colgado" | Comportamiento normal con driver Docker | Dejar la terminal abierta y usar la URL en otra |
| PVC en `Pending` | Falta el provisionador de almacenamiento | `minikube addons enable storage-provisioner default-storageclass` |

Comandos útiles: `kubectl logs <pod> -n practica-s08`, `kubectl describe pod <pod> -n practica-s08`, `kubectl get events -n practica-s08 --sort-by=.lastTimestamp`.
