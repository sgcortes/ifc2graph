# IFC2GRAPH — Navegación de accesibilidad en edificios BIM

Convierte modelos de edificios en formato **IFC** en grafos de accesibilidad navegables.  
Permite visualizar la planta del edificio, explorar el grafo de conexiones entre espacios y calcular rutas óptimas (incluyendo modo ♿ silla de ruedas).

---

## Características

- 📂 **Carga de archivos IFC** directamente desde el navegador
- 🗺️ **Vista en planta 2D** con selector de planta, zoom con rueda del ratón y pan
- 🧊 **Grafo 3D interactivo** con todas las plantas superpuestas
- 🔍 **Tooltips** con información de cada nodo (tipo, nombre, planta, ancho de puerta…)
- 🔴 **Cálculo de ruta óptima** (Dijkstra) resaltada en ambas vistas
- ♿ **Modo accesible** que evita escaleras y puertas estrechas (< 0,85 m)
- 🧱 **Control de capas** independiente: muros, conexiones, ruta, y cada tipo de nodo
- ⬤ **Control de tamaño de nodos** por separado para 2D y 3D
- 💬 **Toggle de tooltips** en 2D para facilitar la selección de nodos
- 🛗 Detección automática de **ascensores** (cabinas por planta agrupadas por hueco)
- 🪜 Detección y conexión automática de **tramos de escalera** consecutivos

---

## Requisitos previos

### Opción A — Python estándar (recomendada en Linux / macOS)

- Python 3.10 o superior
- Las dependencias se instalan con `pip` (ver más abajo)

### Opción B — OSGeo4W (Windows, si ya lo tienes instalado)

Si usas la distribución [OSGeo4W](https://trac.osgeo.org/osgeo4w/) de Python en Windows
(necesaria para que `shapely` encuentre las DLLs de GEOS), el ejecutable se encuentra en:

```
C:\Users\<usuario>\AppData\Local\Programs\OSGeo4W\apps\Python312\python.exe
```

El archivo `app.py` detecta automáticamente este entorno y añade el directorio de DLLs
al path de carga en tiempo de ejecución.

---

## Instalación

```bash
# 1. Clonar el repositorio
git clone https://github.com/TU_USUARIO/ifc2graph.git
cd ifc2graph

# 2. (Opcional) Crear entorno virtual
python -m venv venv
source venv/bin/activate        # Linux / macOS
venv\Scripts\activate.bat       # Windows CMD
venv\Scripts\Activate.ps1       # Windows PowerShell

# 3. Instalar dependencias
pip install -r webapp/requirements.txt
```

---

## Ejecución

```bash
cd webapp
python run.py
```

Abre el navegador en **http://localhost:8000**

> También puedes lanzarlo directamente con uvicorn:
> ```bash
> uvicorn app:app --host 127.0.0.1 --port 8000 --reload
> ```

---

## Uso

1. **Carga un archivo `.ifc`** con el botón *Cargar archivo IFC*
2. El modelo se procesa automáticamente: espacios, puertas, escaleras, ascensores y rampas se convierten en nodos y aristas del grafo
3. **Selecciona la planta** con el desplegable superior para navegar por la vista 2D
4. **Haz clic sobre un nodo** en la vista 2D para establecerlo como **Origen** o **Destino**  
   *(el badge naranja/verde indica qué rol se asignará al próximo clic)*
5. Pulsa **▶ Calcular ruta** para obtener la ruta óptima, que se resaltará en rojo en ambas vistas
6. Activa **♿ Silla de ruedas** para forzar una ruta que evite escaleras y puertas estrechas
7. Usa la **barra de capas** para mostrar/ocultar muros, conexiones, ruta y tipos de nodo individualmente
8. Ajusta el **tamaño de nodos** con los sliders ⬤ 2D / ⬤ 3D
9. Pulsa **💬 Tooltips** para desactivar los popups en 2D y seleccionar nodos con más precisión

---

## Estructura del proyecto

```
ifc2graph/
│
├── webapp/
│   ├── app.py              # Backend FastAPI (API REST + servido de estáticos)
│   ├── bim_mapper.py       # Núcleo: extracción IFC → grafo NetworkX
│   ├── run.py              # Script de lanzamiento rápido
│   ├── requirements.txt    # Dependencias Python
│   └── static/
│       ├── index.html      # Frontend SPA (Plotly.js + vanilla JS)
│       └── logo.png        # Logo institucional (opcional)
│
├── MODELOS/                # Modelos IFC de ejemplo (no incluidos en el repo)
├── .gitignore
└── README.md
```

---

## Dependencias principales

| Paquete | Uso |
|---|---|
| `fastapi` | Framework web backend |
| `uvicorn` | Servidor ASGI |
| `ifcopenshell` | Lectura y geometría de archivos IFC |
| `networkx` | Grafo de accesibilidad y Dijkstra |
| `shapely` | Geometría 2D (polilíneas, puntos) |
| `python-multipart` | Carga de ficheros en FastAPI |
| [Plotly.js](https://plotly.com/javascript/) | Visualización 2D y 3D (CDN, sin instalar) |

---

## API REST

| Método | Endpoint | Descripción |
|---|---|---|
| `POST` | `/api/upload` | Sube un `.ifc`, devuelve nodos, aristas, plantas y planos |
| `POST` | `/api/route` | Calcula ruta Dijkstra entre dos nodos |

---

## Notas técnicas

- La sesión se almacena **en memoria** (sin base de datos). Al reiniciar el servidor se pierden las sesiones activas; basta con recargar el fichero IFC.
- Los archivos `.ifc` **no se persisten** en disco: se procesan en un fichero temporal que se elimina inmediatamente tras la extracción.
- La detección de ascensores admite modelos donde el ascensor está modelado como **un único elemento multi-planta** o como **cabinas independientes por planta** (se agrupan automáticamente por proximidad XY).
- El modo ♿ excluye aristas marcadas como `accessible=False` (escaleras) y aristas de puertas con ancho < 0,85 m.

---

## Licencia

MIT — ver [LICENSE](LICENSE) para más detalles.

---

*Desarrollado en el contexto de investigación sobre accesibilidad en entornos BIM.*  
*Universidad de Oviedo*
