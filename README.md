# IFC2GRAPH — Navegación de accesibilidad en edificios BIM

Convierte modelos de edificios en formato **IFC** en grafos de accesibilidad navegables,
directamente en el navegador. Sin instalación, sin servidor, sin Python.

🌐 **Demo en vivo:** [sgcortes.github.io/ifc2graph](https://sgcortes.github.io/ifc2graph/)

---

## ¿Qué hace?

Carga un archivo `.ifc` desde tu ordenador y genera automáticamente:

- 🗺️ **Vista en planta 2D** por plantas, con zoom (rueda del ratón) y pan
- 🧊 **Grafo 3D interactivo** con todos los nodos y conexiones
- 🔍 **Tooltips** con información de cada espacio, puerta, escalera o ascensor
- 🔴 **Cálculo de ruta óptima** (Dijkstra) entre dos puntos
- ♿ **Modo silla de ruedas** — evita escaleras y puertas estrechas (< 0,85 m)
- 🧱 **Control de capas** — muros, conexiones, ruta, tipos de nodo
- 🛗 Detección de **ascensores** (cabinas por planta agrupadas automáticamente)
- 🪜 Detección y conexión de **tramos de escalera** consecutivos

**El archivo IFC nunca sale de tu ordenador** — todo el procesamiento ocurre en el navegador.

---

## Uso

1. Abre [sgcortes.github.io/ifc2graph](https://sgcortes.github.io/ifc2graph/)
2. Pulsa **📂 Cargar archivo IFC** y selecciona tu fichero `.ifc`
3. Explora la planta 2D y el grafo 3D
4. Haz clic en dos nodos para seleccionar **Origen** y **Destino**
5. Pulsa **▶ Calcular ruta** para ver la ruta óptima resaltada en rojo
6. Activa ♿ para forzar rutas accesibles (sin escaleras)

---

## Tecnología

| Componente | Descripción |
|---|---|
| [web-ifc](https://github.com/tomvandig/web-ifc) | Parser IFC en WebAssembly — corre en el navegador |
| [Plotly.js](https://plotly.com/javascript/) | Visualización 2D y 3D interactiva |
| Dijkstra (JS) | Cálculo de rutas óptimas con soporte para modo accesible |
| Vanilla JS | Sin frameworks, sin dependencias de servidor |

---

## Estructura

```
docs/
├── index.html       # App completa (SPA)
├── bim_mapper.js    # Extractor IFC → grafo (port de bim_mapper.py a JS)
└── logo.png         # Logo institucional
```

La carpeta `docs/` es la raíz de GitHub Pages.

---

## Ejecutar localmente

Basta con servir la carpeta `docs/` con cualquier servidor HTTP estático:

```bash
# Con Python (si lo tienes instalado)
cd docs
python -m http.server 8080
# Abre http://localhost:8080
```

O simplemente abre `docs/index.html` directamente en el navegador
(algunas funciones de web-ifc requieren servidor HTTP por restricciones CORS).

---

## Tipos de elementos IFC detectados

| Tipo IFC | Nodo en el grafo |
|---|---|
| `IfcSpace` | 🏠 Habitación |
| `IfcSlab` (pequeño) | 🟦 Suelo / Pasillo |
| `IfcDoor` | 🚪 Puerta |
| `IfcStairFlight` | 🪜 Escalera |
| `IfcRamp` / `IfcRampFlight` | ↗️ Rampa |
| `IfcTransportElement` (ascensor) | 🛗 Ascensor |

---

## Generador Python HSIMG V13

El repositorio también incluye el generador Python empleado para construir y
validar grafos HSIMG en formato GeoPackage. La versión más reciente es V13 y
conserva las iteraciones anteriores para reproducibilidad.

V13 añade conexiones seguras para puertas y portones asociados explícitamente
al mismo `IfcSpace` cuando el acceso recto al nodo representativo había sido
rechazado. Los enlaces se calculan dentro del dominio transitable, nunca por
mera proximidad, son bidireccionales y se validan para peatón general y silla
de ruedas.

```powershell
python -m venv .venv
.\.venv\Scripts\pip.exe install -r requirements.txt
.\.venv\Scripts\python.exe scripts\run_v13_export.py modelo.ifc `
  --output-dir .qa\v13_release
.\.venv\Scripts\python.exe -m unittest discover -s tests
```

Componentes principales:

- `hsimg.py`: núcleo del generador.
- `v13hsimg.py`: versión actual.
- `scripts/run_v13_export.py`: ejecución y exportación.
- `scripts/validate_v13_release.py`: validación de un GeoPackage V13.
- `tests/`: 64 pruebas automatizadas.
- [`docs/V13_FINALIST_GATE_CONNECTIVITY.md`](docs/V13_FINALIST_GATE_CONNECTIVITY.md): metodología y evidencia de V13.
- [`GEOPACKAGE_SCHEMA.md`](GEOPACKAGE_SCHEMA.md): estructura del GeoPackage.

Los modelos IFC y los GeoPackages generados no se incluyen en GitHub.

---

## Licencia

MIT — ver [LICENSE](LICENSE) para más detalles.

---

*Desarrollado en el contexto de investigación sobre accesibilidad en entornos BIM.*
*Universidad de Oviedo*
