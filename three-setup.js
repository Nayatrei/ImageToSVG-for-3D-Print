import * as THREE from './vendor/three/build/three.module.js';
import { SVGLoader } from './vendor/three/examples/jsm/loaders/SVGLoader.js';
import { OBJExporter } from './vendor/three/examples/jsm/exporters/OBJExporter.js';
import * as BufferGeometryUtils from './vendor/three/examples/jsm/utils/BufferGeometryUtils.js';

window.THREE = THREE;
window.SVGLoader = SVGLoader;
window.OBJExporter = OBJExporter;
window.BufferGeometryUtils = BufferGeometryUtils;
