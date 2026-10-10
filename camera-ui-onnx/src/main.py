from __future__ import annotations

import asyncio
import os
import platform
import shutil
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

import onnxruntime as ort
from camera_ui_ml import (
    BoxDetector,
    Embedder,
    LandmarkDetector,
    PlateOcr,
    crop_rgb,
    decode_image,
    embed_face_images,
    normalize_box,
    reset_stored_settings,
    scale_box,
)
from camera_ui_ml.detectors.clip import ClipEncoder
from camera_ui_sdk import (
    API_EVENT,
    BasePlugin,
    CameraDevice,
    ClipDetectionInterface,
    ClipDetectionPluginResponse,
    ClipTextEmbeddingResult,
    Detection,
    DeviceStorage,
    FaceDetection,
    FaceDetectionInterface,
    FaceDetectionPluginResponse,
    FaceEmbeddingInterface,
    FaceEmbeddingPluginResponse,
    ImageMetadata,
    JsonSchema,
    LicensePlateDetection,
    LicensePlateDetectionInterface,
    LicensePlateDetectionPluginResponse,
    LoggerService,
    ObjectDetectionInterface,
    ObjectDetectionPluginResponse,
    PersonEmbeddingInterface,
    PersonEmbeddingPluginResponse,
    PluginAPI,
    Point,
    SegmentationImage,
    SegmentationInterface,
    SegmentationPluginResponse,
    VideoFrameData,
)

from defaults import (
    CLIP_MODEL_LABELS,
    CLIP_VISION_MODELS,
    DEFAULT_CLIP_VISION,
    DEFAULT_EXECUTION_PROVIDER,
    DEFAULT_FACE_DETECTOR,
    DEFAULT_FACE_EMBEDDER,
    DEFAULT_LPD_DETECTOR,
    DEFAULT_OBJECT_MODEL,
    DEFAULT_OCR,
    DEFAULT_OPTION,
    DEFAULT_SEGMENTATION_MODEL,
    EXECUTION_PROVIDERS,
    FACE_DETECTOR_MODELS,
    FACE_EMBEDDER_MODELS,
    FACE_EMBEDDERS,
    FACE_LANDMARK_MODEL,
    LPD_DETECTOR_MODELS,
    MODEL_BASE_URL,
    MODULE_BACKENDS,
    OBJECT_MODELS,
    OCR_ALPHABET,
    OCR_INPUT_HEIGHT,
    OCR_INPUT_WIDTH,
    OCR_MAX_SLOTS,
    OCR_MODELS,
    OCR_PAD_CHAR,
    PERSON_EMBEDDER_HEIGHT,
    PERSON_EMBEDDER_MODEL,
    PERSON_EMBEDDER_WIDTH,
    SEGMENTATION_MODELS,
    clip_family,
    clip_score_band,
    clip_text_for,
    resolve_model,
)
from model_manager import OnnxModelManager, ProviderList
from modules import installed_modules, is_module, usable_choice
from reid import PersonEmbedder, Segmenter, embed_people_in_pictures, embed_person_images, segment_images
from sensors.attribute_sensor import ViONAttributeSensor
from sensors.clip_sensor import ONNXClipSensor
from sensors.face_embedder_sensor import ONNXFaceEmbedderSensor
from sensors.face_sensor import ONNXFaceSensor
from sensors.lpd_sensor import ONNXLPDSensor
from sensors.object_sensor import ONNXObjectSensor
from sensors.person_embedder_sensor import ONNXPersonEmbedderSensor
from sensors.segmenter_sensor import ONNXSegmenterSensor
from siglip import SiglipEncoder, is_siglip
from trained import is_trained, resolve_object_model, trained_models
from trained import model_name as trained_model_name


class ONNXPlugin(
    BasePlugin,
    ObjectDetectionInterface,
    FaceDetectionInterface,
    FaceEmbeddingInterface,
    LicensePlateDetectionInterface,
    ClipDetectionInterface,
    PersonEmbeddingInterface,
    SegmentationInterface,
):
    def __init__(self, logger: LoggerService, api: PluginAPI, storage: DeviceStorage[Any]) -> None:
        super().__init__(logger, api, storage)
        self.logger.log(f"Доступные провайдеры: {', '.join(ort.get_available_providers())}")
        self.model_manager = OnnxModelManager(api.storagePath, logger, self._resolve_provider_lists)

        self.object_detectors: dict[str, BoxDetector] = {}
        self.face_detectors: dict[str, BoxDetector] = {}
        self.face_embedders: dict[str, Embedder] = {}
        self.face_landmarkers: dict[str, LandmarkDetector] = {}
        self.plate_detectors: dict[str, BoxDetector] = {}
        self.ocr_models: dict[str, PlateOcr] = {}
        self.clip_encoders: dict[str, ClipEncoder] = {}
        # loaded when first needed (prepare_person_embedder, prepare_segmenter), never at start: every camera of every
        # ML plugin process gets these sensors, and a model each in every process once hung the 8 GB bench
        self.person_embedders: dict[str, PersonEmbedder] = {}
        self.segmenters: dict[str, Segmenter] = {}
        self.attribute_backends: dict[str, Any] = {}
        self._preparing: set[str] = set()
        self._failed_models: dict[str, float] = {}
        # the files of the module version each pause above is for: only another version lifts it early
        self._failed_module_files: dict[str, object] = {}
        # why the last load of a model failed, until it loads: what a sensor tells the server (load_state)
        self._load_errors: dict[str, str] = {}
        self._trained_version = -1
        self._modules_version = -1
        # the files each module detector was built from, or is being built from while it loads: an update keeps the
        # model name, not the files
        self._module_files: dict[str, object] = {}
        self._module_reloading: set[str] = set()
        self._models_generation = 0
        self._modules_watch: asyncio.Task[None] | None = None

        self._sensors: dict[str, dict[str, Any]] = {}
        self._warned_provider: str | None = None

        self.api.on(API_EVENT.FINISH_LAUNCHING, self._on_start)
        self.api.on(API_EVENT.SHUTDOWN, self._on_shutdown)

    @property
    def storage_schema(self) -> list[JsonSchema]:
        return [
            {
                "type": "string",
                "key": "clip_vision_model",
                "title": "Модель CLIP (изображения)",
                "description": "Модель CLIP для эмбеддингов семантического поиска, общая для всех камер. После её смены записи нужно переиндексировать.",
                "enum": [DEFAULT_OPTION, *CLIP_VISION_MODELS],
                "enumLabels": {DEFAULT_OPTION: "По умолчанию", **CLIP_MODEL_LABELS},
                "store": True,
                "defaultValue": DEFAULT_OPTION,
                "required": True,
                "onSet": self._on_clip_model_change,
            },
            {
                "type": "string",
                "key": "face_embedder_model",
                "title": "Модель эмбеддингов лиц",
                "description": "Модель, преобразующая лицо в вектор, общая для всех камер. После её смены эмбеддинги сохранённых лиц будут пересчитаны.",
                "enum": [DEFAULT_OPTION, *FACE_EMBEDDER_MODELS],
                "enumLabels": {DEFAULT_OPTION: "По умолчанию"},
                "store": True,
                "defaultValue": DEFAULT_OPTION,
                "required": True,
                "onSet": self._on_face_embedder_change,
            },
            {
                "type": "string",
                "key": "execution_provider",
                "title": "Провайдер выполнения",
                "description": (
                    "Аппаратный бэкенд для инференса. 'auto' выбирает CUDA в Linux/Windows "
                    "(x86_64), в остальных случаях — CPU. 'tensorrt' использует провайдер NVIDIA TensorRT "
                    "(первый запуск медленнее: строится и кэшируется движок). При сбое всегда используется CPU. "
                    f"Доступно в этой системе: {', '.join(ort.get_available_providers())}."
                ),
                "enum": EXECUTION_PROVIDERS,
                "store": True,
                "defaultValue": DEFAULT_EXECUTION_PROVIDER,
                "required": True,
                "onSet": self._on_provider_change,
            },
            {
                "type": "string",
                "key": "device_ids",
                "title": "ID устройств CUDA",
                "description": (
                    'Индекс(ы) GPU для CUDA; для нескольких GPU — через запятую (например, "0" или "0,1"). '
                    "Каждое устройство получает свою сессию инференса, поэтому распознавание идёт параллельно на всех GPU."
                ),
                "store": True,
                "defaultValue": "0",
                "onSet": self._on_provider_change,
            },
            {
                "type": "string",
                "key": "active_hardware",
                "title": "Активное оборудование",
                "description": "Оборудование, на котором сейчас выполняется инференс загруженных моделей.",
                "readonly": True,
                "store": False,
                "onGet": self._active_hardware,
            },
            {
                "type": "button",
                "key": "reset_defaults",
                "title": "Сбросить настройки",
                "description": "Сбросить все настройки плагина к значениям по умолчанию",
                "color": "danger",
                "onSet": self._reset_settings,
            },
            {
                "type": "button",
                "key": "redownload_models",
                "title": "Скачать модели заново",
                "description": "Очистить локальный кэш моделей и заново скачать актуальные модели.",
                "onSet": self._redownload_models,
            },
        ]

    async def configureCameras(self, cameras: list[CameraDevice]) -> None:
        for camera in cameras:
            await self._add_sensors(camera)

    async def onCameraAdded(self, camera: CameraDevice) -> None:
        await self._add_sensors(camera)

    async def onCameraReleased(self, cameraId: str) -> None:
        sensors = self._sensors.pop(cameraId, {})
        for sensor in sensors.values():
            await sensor.destroy()

    async def get_object_detector(self, model_name: str) -> BoxDetector:
        detector = self.object_detectors.get(model_name)
        if not detector:
            detector = BoxDetector(self.model_manager, self.logger, name="object detector", multiclass=True)
            self.object_detectors[model_name] = detector
            if is_module(model_name):
                # known while it loads: a rollback meanwhile differs from it, and check_modules loads that version
                # next to this load instead of waiting for it to end
                self._module_files[model_name] = self._module_signature(model_name)
            try:
                await self._initialize_object_detector(detector, model_name)
            except Exception:
                # a replacement check_modules put in meanwhile stays
                if self.object_detectors.get(model_name) is detector:
                    self.object_detectors.pop(model_name, None)
                    self._module_files.pop(model_name, None)
                raise
        else:
            await detector.initialize(model_name)
        return detector

    async def _initialize_object_detector(self, detector: BoxDetector, model_name: str) -> object:
        # Keep the labels and signature of the version whose load is being started.
        signature = self._module_signature(model_name) if is_module(model_name) else None
        # the version this load starts with: its labels, and what the server is told of it
        module = installed_modules.entry(model_name, MODULE_BACKENDS) if is_module(model_name) else None
        classes = None
        if is_trained(model_name):
            trained = trained_models.entry(model_name)
            classes = trained.get("classes") if trained else None
        elif module is not None:
            classes = module.get("labels")
        try:
            await detector.initialize(model_name)
        except Exception as error:
            if module is not None:
                self._report_module(module, str(error) or type(error).__name__)
            self._load_failed(model_name, error)
            raise
        self._load_succeeded(model_name)
        if classes and not detector.labels:
            detector.labels = {index: str(label) for index, label in enumerate(classes)}
        if module is not None:
            self._report_module(module, None)
        return signature

    def _report_module(self, module: dict[str, Any], error: str | None) -> None:
        # the server keeps a version that loaded as the way back of an update (server/src/manager/moduleManager.ts)
        if not installed_modules.report(module, error):
            self.logger.warn(f"Модуль {module.get('id')}: состояние загрузки не записано для сервера")

    def model_failed(self, model_name: str) -> bool:
        """The model failed to load a short while ago and is not tried again yet."""
        return time.monotonic() < self._failed_models.get(model_name, 0)

    def load_state(self, runtime: Mapping[str, Any], *names: str) -> Any:
        """A sensor's models as the server reads them (modelSpec): with nothing of `runtime` loaded, whether the last load
        of one of `names` failed (`loadState: failed`, `loadError`) or the first only waits to be loaded when it is
        first needed (`loadState: pending`, Re-ID with the first person). The server shows a waiting model as
        connected and only a failed one as not working (server/src/manager/analyticsRegistry.ts). Any: the SDK's
        ModelSpec has no keys for it yet, the server reads them as they come."""
        if runtime.get("models") or not names:
            return dict(runtime)
        failed = next((name for name in names if name in self._load_errors), None)
        if failed is None:
            return {**runtime, "loadModel": names[0], "loadState": "pending"}
        return {**runtime, "loadModel": failed, "loadState": "failed", "loadError": self._load_errors[failed]}

    def _load_failed(self, model_name: str, error: BaseException) -> None:
        message = (str(error) or type(error).__name__)[:300]
        # a model a sensor asks for on every frame fails on every frame: the server hears of it once
        if self._load_errors.get(model_name) == message:
            return
        self._load_errors[model_name] = message
        self._refresh_model_specs()

    def _load_succeeded(self, model_name: str) -> None:
        if self._load_errors.pop(model_name, None) is not None:
            self._refresh_model_specs()

    def _refresh_model_specs(self) -> None:
        # the server learns of a failed or a mended load at once, not with the sensor's next change of model
        for sensors in self._sensors.values():
            for sensor in sensors.values():
                sensor.updateModelSpec()

    async def get_face_detector(self, model_name: str) -> BoxDetector:
        detector = self.face_detectors.get(model_name)
        if not detector:
            detector = BoxDetector(self.model_manager, self.logger, name="face detector")
            self.face_detectors[model_name] = detector
            try:
                await detector.initialize(model_name)
            except Exception as error:
                self.face_detectors.pop(model_name, None)
                self._load_failed(model_name, error)
                raise
        else:
            await detector.initialize(model_name)
        self._load_succeeded(model_name)
        return detector

    async def get_face_embedder(self, space: str) -> Embedder:
        spec = FACE_EMBEDDERS.get(space, FACE_EMBEDDERS[DEFAULT_FACE_EMBEDDER])
        embedder = self.face_embedders.get(space)
        if not embedder:
            embedder = Embedder(
                self.model_manager,
                self.logger,
                size=spec.size,
                normalize=spec.normalize,
                aligned=spec.aligned,
            )
            self.face_embedders[space] = embedder
            try:
                await embedder.initialize(spec.model)
            except Exception as error:
                self.face_embedders.pop(space, None)
                self._load_failed(space, error)
                raise
        else:
            await embedder.initialize(spec.model)
        self._load_succeeded(space)
        return embedder

    async def get_face_landmarker(self) -> LandmarkDetector:
        landmarker = self.face_landmarkers.get(FACE_LANDMARK_MODEL)
        if not landmarker:
            landmarker = LandmarkDetector(self.model_manager, self.logger)
            self.face_landmarkers[FACE_LANDMARK_MODEL] = landmarker
            try:
                await landmarker.initialize(FACE_LANDMARK_MODEL)
            except Exception as error:
                self.face_landmarkers.pop(FACE_LANDMARK_MODEL, None)
                self._load_failed(FACE_LANDMARK_MODEL, error)
                raise
        else:
            await landmarker.initialize(FACE_LANDMARK_MODEL)
        self._load_succeeded(FACE_LANDMARK_MODEL)
        return landmarker

    async def get_person_embedder(self) -> PersonEmbedder:
        embedder = self.person_embedders.get(PERSON_EMBEDDER_MODEL)
        if not embedder:
            embedder = PersonEmbedder(
                self.model_manager,
                self.logger,
                width=PERSON_EMBEDDER_WIDTH,
                height=PERSON_EMBEDDER_HEIGHT,
            )
            self.person_embedders[PERSON_EMBEDDER_MODEL] = embedder
            try:
                await embedder.initialize(PERSON_EMBEDDER_MODEL)
            except Exception as error:
                self.person_embedders.pop(PERSON_EMBEDDER_MODEL, None)
                self._load_failed(PERSON_EMBEDDER_MODEL, error)
                raise
        else:
            await embedder.initialize(PERSON_EMBEDDER_MODEL)
        self._load_succeeded(PERSON_EMBEDDER_MODEL)
        return embedder

    async def get_segmenter(self, model_name: str) -> Segmenter:
        segmenter = self.segmenters.get(model_name)
        if not segmenter:
            segmenter = Segmenter(
                self.model_manager, self.logger, size=(SEGMENTATION_MODELS.get(model_name, 320),) * 2
            )
            self.segmenters[model_name] = segmenter
            try:
                await segmenter.initialize(model_name)
            except Exception as error:
                self.segmenters.pop(model_name, None)
                self._load_failed(model_name, error)
                raise
        else:
            await segmenter.initialize(model_name)
        self._load_succeeded(model_name)
        return segmenter

    async def get_plate_detector(self, model_name: str) -> BoxDetector:
        detector = self.plate_detectors.get(model_name)
        if not detector:
            detector = BoxDetector(
                self.model_manager,
                self.logger,
                name="plate detector",
                parse="end2end",
                threshold=0.25,
            )
            self.plate_detectors[model_name] = detector
            try:
                await detector.initialize(model_name)
            except Exception as error:
                self.plate_detectors.pop(model_name, None)
                self._load_failed(model_name, error)
                raise
        else:
            await detector.initialize(model_name)
        self._load_succeeded(model_name)
        return detector

    async def get_ocr(self, model_name: str) -> PlateOcr:
        ocr = self.ocr_models.get(model_name)
        if not ocr:
            ocr = PlateOcr(
                self.model_manager,
                self.logger,
                width=OCR_INPUT_WIDTH,
                height=OCR_INPUT_HEIGHT,
                slots=OCR_MAX_SLOTS,
                alphabet=OCR_ALPHABET,
                pad_char=OCR_PAD_CHAR,
            )
            self.ocr_models[model_name] = ocr
            try:
                await ocr.initialize(model_name)
            except Exception as error:
                self.ocr_models.pop(model_name, None)
                self._load_failed(model_name, error)
                raise
        else:
            await ocr.initialize(model_name)
        self._load_succeeded(model_name)
        return ocr

    async def get_clip_encoder(self, model_name: str) -> ClipEncoder:
        encoder = self.clip_encoders.get(model_name)
        if not encoder:
            family = clip_family(model_name)
            encoder = (
                SiglipEncoder(
                    self.model_manager, self.logger, embedding_model=family, base_url=MODEL_BASE_URL
                )
                if is_siglip(family)
                else ClipEncoder(self.model_manager, self.logger, embedding_model=family)
            )
            self.clip_encoders[model_name] = encoder
            try:
                await encoder.initialize(model_name, clip_text_for(model_name))
            except Exception as error:
                self.clip_encoders.pop(model_name, None)
                self._load_failed(model_name, error)
                raise
        else:
            await encoder.initialize(model_name, clip_text_for(model_name))
        self._load_succeeded(model_name)
        return encoder

    async def objectDetectionSettings(self) -> list[JsonSchema] | None:
        return [
            {
                "type": "string",
                "key": "model",
                "title": "Модель",
                "description": "Модель YOLO для тестирования",
                "required": True,
                "defaultValue": DEFAULT_OPTION,
                "enum": [DEFAULT_OPTION, *OBJECT_MODELS, *installed_modules.choices(MODULE_BACKENDS)],
                "enumLabels": {DEFAULT_OPTION: "По умолчанию", **installed_modules.choices(MODULE_BACKENDS)},
                "store": False,
            },
        ]

    async def testObjectDetection(
        self, image_data: bytes, metadata: ImageMetadata, config: dict[str, Any]
    ) -> ObjectDetectionPluginResponse | None:
        requested = usable_choice(config.get("model"), MODULE_BACKENDS, DEFAULT_OPTION)
        model_name: str = resolve_object_model(requested, DEFAULT_OBJECT_MODEL, DEFAULT_OPTION)
        detector = await self.get_object_detector(model_name)
        if not detector.initialized:
            return None

        raw = await detector.detect_single(image_data, metadata)
        detections: list[Detection] = [
            {
                "label": detector.labels.get(cid, "unknown"),  # type: ignore[typeddict-item]
                "confidence": conf,
                "box": box,
            }
            for cid, conf, box in raw
        ]
        return {"detected": len(detections) > 0, "detections": detections}

    async def detectObjects(
        self, frame: VideoFrameData, config: dict[str, Any] | None = None
    ) -> ObjectDetectionPluginResponse | None:
        requested = usable_choice((config or {}).get("model"), MODULE_BACKENDS, DEFAULT_OPTION)
        model_name = resolve_object_model(requested, DEFAULT_OBJECT_MODEL, DEFAULT_OPTION)
        detector = await self.get_object_detector(model_name)
        if not detector.initialized:
            return None

        raw = await detector.detect_frame(frame)
        width, height = frame["width"], frame["height"]
        detections: list[Detection] = [
            {
                "label": detector.labels.get(cid, "unknown"),  # type: ignore[typeddict-item]
                "confidence": conf,
                "box": normalize_box(box, width, height),
            }
            for cid, conf, box in raw
        ]
        return {"detected": len(detections) > 0, "detections": detections}

    async def faceDetectionSettings(self) -> list[JsonSchema] | None:
        return [
            {
                "type": "string",
                "key": "detector_model",
                "title": "Модель детектора",
                "description": "Модель обнаружения лиц для тестирования",
                "required": True,
                "defaultValue": DEFAULT_OPTION,
                "enum": [DEFAULT_OPTION, *FACE_DETECTOR_MODELS],
                "enumLabels": {DEFAULT_OPTION: "По умолчанию"},
                "store": False,
            },
        ]

    async def testFaceDetection(
        self, image_data: bytes, metadata: ImageMetadata, config: dict[str, Any]
    ) -> FaceDetectionPluginResponse | None:
        detector_name: str = resolve_model(config.get("detector_model"), DEFAULT_FACE_DETECTOR)

        detector = await self.get_face_detector(detector_name)
        if not detector.initialized:
            return None

        rgb = decode_image(image_data)
        height, width = int(rgb.shape[0]), int(rgb.shape[1])
        raw = await detector.detect(rgb)
        if not raw:
            return {"detected": False, "detections": []}

        scale_x = width / detector.input_size[0]
        scale_y = height / detector.input_size[1]

        detections: list[FaceDetection] = []
        for _cid, conf, box in raw:
            image_box = scale_box(box, scale_x, scale_y)
            detections.append(
                {
                    "label": "person",
                    "attribute": "face",
                    "confidence": conf,
                    "box": normalize_box(image_box, width, height),
                }
            )

        return {"detected": len(detections) > 0, "detections": detections}

    async def detectFaces(
        self, frame: VideoFrameData, config: dict[str, Any] | None = None
    ) -> FaceDetectionPluginResponse | None:
        cfg = config or {}
        detector_name = resolve_model(cfg.get("detector_model"), DEFAULT_FACE_DETECTOR)

        detector = await self.get_face_detector(detector_name)
        if not detector.initialized:
            return None

        raw = await detector.detect_frame(frame)
        if not raw:
            return {"detected": False, "detections": []}

        width, height = frame["width"], frame["height"]

        detections: list[FaceDetection] = []
        for _cid, conf, box in raw:
            detections.append(
                {
                    "label": "person",
                    "attribute": "face",
                    "confidence": conf,
                    "box": normalize_box(box, width, height),
                }
            )

        return {"detected": len(detections) > 0, "detections": detections}

    async def licensePlateDetectionSettings(self) -> list[JsonSchema] | None:
        return [
            {
                "type": "string",
                "key": "detector_model",
                "title": "Модель детектора",
                "description": "Модель YOLOv9 для тестирования обнаружения номерных знаков",
                "required": True,
                "defaultValue": DEFAULT_OPTION,
                "enum": [DEFAULT_OPTION, *LPD_DETECTOR_MODELS],
                "enumLabels": {DEFAULT_OPTION: "По умолчанию"},
                "store": False,
            },
            {
                "type": "string",
                "key": "ocr_model",
                "title": "Модель OCR",
                "description": "Модель CCT для тестирования распознавания текста номеров",
                "required": True,
                "defaultValue": DEFAULT_OPTION,
                "enum": [DEFAULT_OPTION, *OCR_MODELS],
                "enumLabels": {DEFAULT_OPTION: "По умолчанию"},
                "store": False,
            },
        ]

    async def testLicensePlateDetection(
        self, image_data: bytes, metadata: ImageMetadata, config: dict[str, Any]
    ) -> LicensePlateDetectionPluginResponse | None:
        detector_name: str = resolve_model(config.get("detector_model"), DEFAULT_LPD_DETECTOR)
        ocr_name: str = resolve_model(config.get("ocr_model"), DEFAULT_OCR)

        detector = await self.get_plate_detector(detector_name)
        ocr = await self.get_ocr(ocr_name)
        if not detector.initialized or not ocr.initialized:
            return None

        rgb = decode_image(image_data)
        height, width = int(rgb.shape[0]), int(rgb.shape[1])
        raw = await detector.detect(rgb)

        scale_x = width / detector.input_size[0]
        scale_y = height / detector.input_size[1]

        detections: list[LicensePlateDetection] = []
        for _cid, conf, box in raw:
            image_box = scale_box(box, scale_x, scale_y)
            ocr_result = await ocr.recognize(crop_rgb(rgb, image_box))
            if ocr_result and ocr_result.text:
                detections.append(
                    {
                        "label": "vehicle",
                        "attribute": "license_plate",
                        "confidence": conf,
                        "plateText": ocr_result.text,
                        "box": normalize_box(image_box, width, height),
                    }
                )

        return {"detected": len(detections) > 0, "detections": detections}

    async def detectLicensePlates(
        self, frame: VideoFrameData, config: dict[str, Any] | None = None
    ) -> LicensePlateDetectionPluginResponse | None:
        cfg = config or {}
        detector_name = resolve_model(cfg.get("detector_model"), DEFAULT_LPD_DETECTOR)
        ocr_name = resolve_model(cfg.get("ocr_model"), DEFAULT_OCR)

        detector = await self.get_plate_detector(detector_name)
        ocr = await self.get_ocr(ocr_name)
        if not detector.initialized or not ocr.initialized:
            return None

        raw = await detector.detect_frame(frame)
        if not raw:
            return {"detected": False, "detections": []}

        width, height = frame["width"], frame["height"]
        rgb_bytes = bytes(frame["data"])

        detections: list[LicensePlateDetection] = []
        for _cid, conf, box in raw:
            ocr_result = await ocr.recognize_from_crop(rgb_bytes, width, height, box)
            if ocr_result and ocr_result.text:
                detections.append(
                    {
                        "label": "vehicle",
                        "attribute": "license_plate",
                        "confidence": conf,
                        "plateText": ocr_result.text,
                        "box": normalize_box(box, width, height),
                    }
                )

        return {"detected": len(detections) > 0, "detections": detections}

    async def clipSettings(self) -> list[JsonSchema] | None:
        return [
            {
                "type": "string",
                "key": "vision_model",
                "title": "Модель изображений",
                "description": "Модель CLIP (изображения) для тестирования",
                "required": True,
                "defaultValue": DEFAULT_OPTION,
                "enum": [DEFAULT_OPTION, *CLIP_VISION_MODELS],
                "enumLabels": {DEFAULT_OPTION: "По умолчанию", **CLIP_MODEL_LABELS},
                "store": False,
            },
        ]

    async def testClipEmbedding(
        self, image_data: bytes, metadata: ImageMetadata, config: dict[str, Any]
    ) -> ClipDetectionPluginResponse | None:
        model_name: str = resolve_model(config.get("vision_model"), self.clip_model())
        encoder = await self.get_clip_encoder(model_name)
        if not encoder.initialized:
            return None

        embedding = await encoder.embed_image(decode_image(image_data))
        if not embedding:
            return None

        return {
            "embeddings": [
                {
                    "label": "image",
                    "box": {"x": 0, "y": 0, "width": 1, "height": 1},
                    "embedding": embedding,
                }
            ],
            "embeddingModel": encoder.embedding_model,
            "scoreBand": clip_score_band(encoder.embedding_model),
        }

    async def detectClipEmbedding(
        self, frame: VideoFrameData, config: dict[str, Any] | None = None
    ) -> ClipDetectionPluginResponse | None:
        model_name = resolve_model((config or {}).get("vision_model"), self.clip_model())
        encoder = await self.get_clip_encoder(model_name)
        if not encoder.initialized:
            return None

        embedding = await encoder.embed_frame(frame["width"], frame["height"], bytes(frame["data"]))
        if not embedding:
            return None

        return {
            "embeddings": [
                {
                    "label": "image",
                    "box": {"x": 0, "y": 0, "width": 1, "height": 1},
                    "embedding": embedding,
                }
            ],
            "embeddingModel": encoder.embedding_model,
            "scoreBand": clip_score_band(encoder.embedding_model),
        }

    async def getTextEmbedding(self, text: str) -> ClipTextEmbeddingResult:
        encoder = await self.get_clip_encoder(self.clip_model())
        if not encoder.initialized:
            return {"embedding": [], "embeddingModel": "", "scoreBand": []}

        embedding = await encoder.embed_text(text)
        return {
            "embedding": embedding,
            "embeddingModel": encoder.embedding_model,
            "scoreBand": clip_score_band(encoder.embedding_model),
        }

    async def embedImages(
        self, images: list[bytes], config: dict[str, Any] | None = None
    ) -> list[ClipDetectionPluginResponse | None]:
        model_name = resolve_model((config or {}).get("vision_model"), self.clip_model())
        encoder = await self.get_clip_encoder(model_name)
        if not encoder.initialized:
            return [None for _ in images]

        results: list[ClipDetectionPluginResponse | None] = []
        for image_data in images:
            try:
                embedding = await encoder.embed_image(decode_image(image_data))
            except Exception:
                embedding = []
            if not embedding:
                results.append(None)
                continue
            results.append(
                {
                    "embeddings": [
                        {
                            "label": "image",
                            "box": {"x": 0, "y": 0, "width": 1, "height": 1},
                            "embedding": embedding,
                        }
                    ],
                    "embeddingModel": encoder.embedding_model,
                    "scoreBand": clip_score_band(encoder.embedding_model),
                }
            )
        return results

    async def getTextEmbeddings(self, text: str) -> list[ClipTextEmbeddingResult]:
        # the plugin serves exactly one configured space
        names = [self.clip_model()]

        results: list[ClipTextEmbeddingResult] = []
        seen: set[str] = set()
        for name in names:
            encoder = await self.get_clip_encoder(name)
            if not encoder.initialized or encoder.embedding_model in seen:
                continue
            embedding = await encoder.embed_text(text)
            if not embedding:
                continue
            seen.add(encoder.embedding_model)
            results.append(
                {
                    "embedding": embedding,
                    "embeddingModel": encoder.embedding_model,
                    "scoreBand": clip_score_band(encoder.embedding_model),
                }
            )
        return results

    def face_embedder_space(self) -> str:
        return resolve_model(self.storage.values.get("face_embedder_model"), DEFAULT_FACE_EMBEDDER)

    async def _on_face_embedder_change(self, new_model: str, _old_model: str) -> None:
        if new_model == _old_model:
            return
        resolved = resolve_model(new_model, DEFAULT_FACE_EMBEDDER)
        await self.get_face_embedder(resolved)
        await self.get_face_landmarker()
        for sensors in self._sensors.values():
            if (embedder := sensors.get("faceEmbedder")) is not None:
                embedder.updateModelSpec()
        self.logger.log(f"Модель эмбеддингов лиц изменена на {resolved}")

    async def faceEmbeddingSettings(self) -> list[JsonSchema] | None:
        return [
            {
                "type": "string",
                "key": "embedder_model",
                "title": "Модель распознавания",
                "description": "Модель распознавания лиц для тестирования",
                "required": True,
                "defaultValue": DEFAULT_OPTION,
                "enum": [DEFAULT_OPTION, *FACE_EMBEDDER_MODELS],
                "enumLabels": {DEFAULT_OPTION: "По умолчанию"},
                "store": False,
            },
        ]

    async def embedFaceImages(
        self,
        images: list[bytes],
        config: dict[str, Any] | None = None,
        landmarks: list[list[Point] | None] | None = None,
    ) -> list[FaceEmbeddingPluginResponse | None]:
        space = resolve_model((config or {}).get("embedder_model"), self.face_embedder_space())
        embedder = await self.get_face_embedder(space)
        landmarker = await self.get_face_landmarker()
        if not embedder.initialized or not landmarker.initialized:
            return [None for _ in images]

        # an empty vector says the picture holds no face the model can use, None
        # is reserved for a plugin that could not run: the caller drops the first
        results = await embed_face_images(landmarker, embedder, images, space, landmarks)
        return [result for result in results]

    async def embedPersonImages(
        self, images: list[bytes], config: dict[str, Any] | None = None
    ) -> list[PersonEmbeddingPluginResponse | None]:
        # asked by a person (search by picture, the plugin page): it waits for the first load
        embedder = await self.get_person_embedder()
        if not embedder.initialized:
            return [None for _ in images]

        # an empty vector says the picture holds nobody the model can use, None is a plugin that could not run
        if (config or {}).get("find") == "person":
            # a picture of a scene (the NVR's search by picture): the biggest person in it, cut tight
            detector = await self.get_object_detector(
                resolve_object_model(DEFAULT_OPTION, DEFAULT_OBJECT_MODEL, DEFAULT_OPTION)
            )
            if not detector.initialized:
                return [None for _ in images]
            found = await embed_people_in_pictures(embedder, detector, images, PERSON_EMBEDDER_MODEL)
            return [result for result in found]
        results = await embed_person_images(embedder, images, PERSON_EMBEDDER_MODEL)
        return [result for result in results]

    async def segmentationSettings(self) -> list[JsonSchema] | None:
        return [
            {
                "type": "string",
                "key": "model",
                "title": "Модель",
                "description": "Модель сегментации для проверки",
                "required": True,
                "defaultValue": DEFAULT_OPTION,
                "enum": [DEFAULT_OPTION, *SEGMENTATION_MODELS],
                "enumLabels": {DEFAULT_OPTION: "По умолчанию"},
                "store": False,
            },
        ]

    async def segmentImages(
        self, images: list[SegmentationImage], config: dict[str, Any] | None = None
    ) -> list[SegmentationPluginResponse | None]:
        model_name = resolve_model((config or {}).get("model"), DEFAULT_SEGMENTATION_MODEL)
        segmenter = await self.get_segmenter(model_name)
        if not segmenter.initialized:
            return [None for _ in images]

        results = await segment_images(segmenter, images)
        return [result for result in results]

    def clip_model(self) -> str:
        return resolve_model(self.storage.values.get("clip_vision_model"), DEFAULT_CLIP_VISION)

    async def _on_clip_model_change(self, new_model: str, _old_model: str) -> None:
        if new_model == _old_model:
            return
        resolved = resolve_model(new_model, DEFAULT_CLIP_VISION)
        await self.get_clip_encoder(resolved)
        for sensors in self._sensors.values():
            if (clip := sensors.get("clip")) is not None:
                clip.updateModelSpec()
        self.logger.log(f"Модель CLIP (изображения) изменена на {resolved}")

    async def _add_sensors(self, camera: CameraDevice) -> None:
        sensors: dict[str, Any] = {}

        obj = ONNXObjectSensor(self, camera, self.logger)
        await camera.addSensor(obj)
        sensors["object"] = obj

        face = ONNXFaceSensor(self, camera, self.logger)
        await camera.addSensor(face)
        sensors["face"] = face

        lpd = ONNXLPDSensor(self, camera, self.logger)
        await camera.addSensor(lpd)
        sensors["lpd"] = lpd

        embedder = ONNXFaceEmbedderSensor(self, self.logger)
        await camera.addSensor(embedder)
        sensors["faceEmbedder"] = embedder

        person = ONNXPersonEmbedderSensor(self, self.logger)
        await camera.addSensor(person)
        sensors["personEmbedder"] = person

        segmenter = ONNXSegmenterSensor(self, self.logger)
        await camera.addSensor(segmenter)
        sensors["segmenter"] = segmenter

        clip = ONNXClipSensor(self, self.logger)
        await camera.addSensor(clip)
        sensors["clip"] = clip

        # attributes of objects ("с пакетом") by the classifiers trained on ViON Cloud
        attributes = ViONAttributeSensor(self, camera, self.logger)
        await camera.addSensor(attributes)
        sensors["attributes"] = attributes

        self._sensors[camera.id] = sensors

    def _active_hardware(self) -> str:
        backends = [
            detector.backend.device
            for detector in (
                *self.object_detectors.values(),
                *self.face_detectors.values(),
                *self.plate_detectors.values(),
                *self.face_embedders.values(),
                *self.face_landmarkers.values(),
                *self.ocr_models.values(),
                *self.person_embedders.values(),
                *self.segmenters.values(),
            )
            if detector.backend is not None
        ]
        backends += [enc.vision.device for enc in self.clip_encoders.values() if enc.vision is not None]
        if not backends:
            return "Модели ещё не загружены"
        return ", ".join(dict.fromkeys(backends))

    def _device_ids(self) -> list[int]:
        raw = str(self.storage.values.get("device_ids", "0"))
        ids = [int(part.strip()) for part in raw.split(",") if part.strip().isdigit()]
        return ids or [0]

    @staticmethod
    def _cuda_options(device_id: int) -> dict[str, Any]:
        return {
            "device_id": device_id,
            "cudnn_conv_algo_search": "HEURISTIC",
            "cudnn_conv_use_max_workspace": "1",
        }

    def _resolve_provider_lists(self) -> list[ProviderList]:
        pref = self.storage.values.get("execution_provider", DEFAULT_EXECUTION_PROVIDER)
        system = platform.system()
        machine = platform.machine()
        available: set[str] = set(ort.get_available_providers())

        x86 = machine in ("x86_64", "AMD64")
        use_cuda = pref == "cuda" or (pref == "auto" and system in ("Linux", "Windows") and x86)

        if pref == "tensorrt" and "TensorrtExecutionProvider" in available:
            cache_dir = os.path.join(self.api.storagePath, "trt-engine-cache")
            os.makedirs(cache_dir, exist_ok=True)
            return [
                [
                    (
                        "TensorrtExecutionProvider",
                        {
                            "device_id": device_id,
                            "trt_engine_cache_enable": True,
                            "trt_engine_cache_path": cache_dir,
                            "trt_timing_cache_enable": True,
                            "trt_timing_cache_path": cache_dir,
                            "trt_fp16_enable": True,
                        },
                    ),
                    ("CUDAExecutionProvider", self._cuda_options(device_id)),
                    "CPUExecutionProvider",
                ]
                for device_id in self._device_ids()
            ]
        if use_cuda and "CUDAExecutionProvider" in available:
            return [
                [
                    ("CUDAExecutionProvider", self._cuda_options(device_id)),
                    "CPUExecutionProvider",
                ]
                for device_id in self._device_ids()
            ]

        wanted = (
            "TensorrtExecutionProvider"
            if pref == "tensorrt"
            else "CUDAExecutionProvider"
            if use_cuda
            else None
        )
        if wanted and wanted not in available:
            self._warn_missing_provider(wanted)

        return [["CPUExecutionProvider"]]

    def _warn_missing_provider(self, provider: str) -> None:
        if self._warned_provider == provider:
            return

        self._warned_provider = provider
        self.logger.warn(
            f"{provider} отсутствует в этой сборке onnxruntime, инференс выполняется на CPU. "
            f"Доступно: {', '.join(ort.get_available_providers())}"
        )

    async def _on_provider_change(self, new_value: object, old_value: object) -> None:
        if new_value == old_value:
            return
        self.logger.log(f"Провайдер выполнения изменён ({old_value} -> {new_value}); перезагрузка моделей")
        self._warned_provider = None
        await self._reload_models()

    async def _reload_models(self) -> None:
        obj = list(self.object_detectors)
        fdet = list(self.face_detectors)
        femb = list(self.face_embedders)
        pdet = list(self.plate_detectors)
        ocr = list(self.ocr_models)
        clip = list(self.clip_encoders)
        person = list(self.person_embedders)
        seg = list(self.segmenters)

        signatures = {n: self._module_signature(n) for n in obj if is_module(n)}
        await self._close_all()
        self.model_manager.reset()

        loaded = await asyncio.gather(
            *(self.get_object_detector(n) for n in obj),
            *(self.get_face_detector(n) for n in fdet),
            *(self.get_face_embedder(n) for n in femb),
            *(self.get_plate_detector(n) for n in pdet),
            *(self.get_ocr(n) for n in ocr),
            *(self.get_clip_encoder(n) for n in clip),
            *(self.get_person_embedder() for _ in person),
            *(self.get_segmenter(n) for n in seg),
            return_exceptions=True,
        )
        # its cameras go on with the standard model at once, without one more failed load on their next frame
        for name, result in zip(obj, loaded[: len(obj)], strict=True):
            if name in signatures and isinstance(result, Exception):
                self._object_load_failed(name, signatures[name])

        for sensors in self._sensors.values():
            for sensor in sensors.values():
                sensor.updateModelSpec()

    async def _reset_settings(self) -> None:
        await reset_stored_settings(self.storage)
        self.logger.log("Настройки сброшены к значениям по умолчанию")

    async def _redownload_models(self, _new: object = None, _old: object = None) -> None:
        self.logger.log("Повторная загрузка моделей (очистка кэша)...")
        shutil.rmtree(self.model_manager.model_path, ignore_errors=True)
        await self._reload_models()
        self.logger.success("Модели загружены заново")

    # ---- models trained on ViON Cloud (trained.py) ----

    def prepare_object_detector(self, model_name: str) -> None:
        """Loads a detector in the background (a newly published trained model); failures are retried
        after a while instead of on every frame."""
        if model_name in self._preparing or time.monotonic() < self._failed_models.get(model_name, 0):
            return
        self._preparing.add(model_name)
        signature = self._module_signature(model_name) if is_module(model_name) else None

        async def load() -> None:
            try:
                await self.get_object_detector(model_name)
                self.logger.success(f"Загружена модель объектов {model_name}")
                # a camera waiting for this model takes it now, not with its next frame: a quiet one may see none
                # for hours
                for sensors in self._sensors.values():
                    obj = sensors.get("object")
                    if obj is not None:
                        obj.take_wanted_model()
            except Exception as error:
                self._object_load_failed(model_name, signature)
                self.logger.error(f"Модель объектов {model_name} не загрузилась: {error}")
            finally:
                self._preparing.discard(model_name)

        asyncio.create_task(load())

    def _object_load_failed(self, model_name: str, signature: object) -> None:
        """A detector that failed is tried again after a while, not on every frame. A module whose installed version
        changed during the load (a rollback) waits for nothing: the version now installed is due at once."""
        if is_module(model_name):
            if signature != self._module_signature(model_name):
                return
            self._failed_module_files[model_name] = signature
        self._failed_models[model_name] = time.monotonic() + 600

    def prepare_person_embedder(self) -> None:
        """Loads the re-ID model in the background, on the first person a camera with Person Re-ID sees."""
        self._prepare_in_background(PERSON_EMBEDDER_MODEL, self.get_person_embedder, "personEmbedder")

    def prepare_segmenter(self, model_name: str) -> None:
        self._prepare_in_background(model_name, lambda: self.get_segmenter(model_name), "segmenter")

    def _prepare_in_background(
        self, model_name: str, load: Callable[[], Awaitable[object]], sensor_key: str
    ) -> None:
        """One load at a time per model; a failed one is tried again after a while, not on every frame."""
        if model_name in self._preparing or time.monotonic() < self._failed_models.get(model_name, 0):
            return
        self._preparing.add(model_name)

        async def run() -> None:
            try:
                await load()
                self.logger.success(f"Загружена модель {model_name}")
                # the metrics of the server show the model once it runs
                for sensors in self._sensors.values():
                    if (sensor := sensors.get(sensor_key)) is not None:
                        sensor.updateModelSpec()
            except Exception as error:
                self._failed_models[model_name] = time.monotonic() + 600
                self.logger.error(f"Модель {model_name} не загрузилась: {error}")
            finally:
                self._preparing.discard(model_name)

        asyncio.create_task(run())

    def check_trained_models(self) -> None:
        """Cheap per-frame check: when the manifest changed, the classifier sensors learn the new labels."""
        trained_models.manifest()
        if trained_models.version == self._trained_version:
            return
        self._trained_version = trained_models.version
        for sensors in self._sensors.values():
            attribute = sensors.get("attributes")
            if attribute is not None:
                attribute.refresh()
        # a trained model given out no more (a module's newer version, a module turned off): its detector goes, unless
        # a camera still detects with it while its next model loads
        in_use = {getattr(sensors.get("object"), "_active_model", None) for sensors in self._sensors.values()}
        for name in [
            n
            for n in self.object_detectors
            if is_trained(n) and n not in in_use and trained_models.entry(n) is None
        ]:
            asyncio.create_task(self._drop_trained_detector(name))

    async def _drop_trained_detector(self, model_name: str) -> None:
        detector = self.object_detectors.pop(model_name, None)
        self._failed_models.pop(model_name, None)
        self.model_manager.forget(model_name)
        if detector is not None:
            await detector.close()
            self.logger.log(f"Модель {model_name} больше не выдаётся и выгружена")

    # ---- modules of the store (modules.py) ----

    def check_modules(self) -> None:
        """Cheap check: when a module was added or removed in the store, the model choices follow."""
        installed_modules.installed()
        if installed_modules.version == self._modules_version:
            return
        self._modules_version = installed_modules.version
        # other files (a rollback, a fixed version): a module that failed is tried again now, not after its wait. The
        # same files (the recheck after a reload of all models) keep the wait: the camera stays on the standard model
        for name in [n for n in self._failed_models if is_module(n)]:
            if self._module_signature(name) != self._failed_module_files.get(name):
                self._failed_models.pop(name, None)
                self._failed_module_files.pop(name, None)
        for sensors in self._sensors.values():
            obj = sensors.get("object")
            if obj is not None:
                obj.refresh_model_choices()
        # a camera whose module is not loaded (its version failed after a restart, the standard model detecting
        # meanwhile) gets the version now installed at once, not with its next frame with motion
        for sensors in self._sensors.values():
            obj = sensors.get("object")
            wanted = obj.wanted_model() if obj is not None else None
            if wanted is not None and is_module(wanted) and wanted not in self.object_detectors:
                self.prepare_object_detector(wanted)
        for name in [n for n in self.object_detectors if is_module(n)]:
            if self._module_signature(name) != self._module_files.get(name):
                asyncio.create_task(self._reload_module_detector(name))

    def _module_signature(self, model_name: str) -> object:
        entry = installed_modules.entry(model_name, MODULE_BACKENDS)
        return (entry.get("version"), installed_modules.files(entry, MODULE_BACKENDS)) if entry else None

    async def _reload_module_detector(self, model_name: str) -> None:
        """Publish a ready replacement only: a failed load leaves the working detector in service."""
        if model_name in self._module_reloading:
            return
        self._module_reloading.add(model_name)
        generation = self._models_generation
        try:
            while generation == self._models_generation:
                if not installed_modules.entry(model_name, MODULE_BACKENDS):
                    old = self.object_detectors.pop(model_name, None)
                    self._module_files.pop(model_name, None)
                    self.model_manager.forget(model_name)
                    if old is not None:
                        await old.close()
                    return
                self.model_manager.forget(model_name)
                candidate = BoxDetector(
                    self.model_manager, self.logger, name="object detector", multiclass=True
                )
                wanted_signature = self._module_signature(model_name)
                try:
                    signature = await self._initialize_object_detector(candidate, model_name)
                except Exception:
                    await candidate.close()
                    if generation == self._models_generation and wanted_signature != self._module_signature(
                        model_name
                    ):
                        continue
                    raise
                except BaseException:
                    await candidate.close()
                    raise
                if generation != self._models_generation:
                    await candidate.close()
                    return
                if signature != self._module_signature(model_name):
                    await candidate.close()
                    continue
                old = self.object_detectors.get(model_name)
                self.object_detectors[model_name] = candidate
                self._module_files[model_name] = signature
                self._failed_models.pop(model_name, None)
                for sensors in self._sensors.values():
                    obj = sensors.get("object")
                    if obj is not None and obj._active_model == model_name:
                        obj.updateModelSpec()
                if old is not None:
                    await old.close()
                self.logger.success(f"Модуль {model_name} загружен заново")
                return
        except Exception as error:
            self.logger.error(f"Модуль {model_name} не загрузился заново: {error}")
        finally:
            self._module_reloading.discard(model_name)

    async def _watch_modules(self) -> None:
        # the settings show a module before any camera detects again: detection only runs while something moves
        while True:
            try:
                self.check_modules()
            except Exception as error:
                self.logger.error(f"Список модулей не прочитан: {error}")
            await asyncio.sleep(5)

    async def get_attribute_backend(self, entry: dict[str, Any]) -> Any:
        name = trained_model_name(entry)
        backend = self.attribute_backends.get(name)
        if backend is None:
            backend = await self.model_manager.ensure_backend(name)
            self.attribute_backends[name] = backend
        return backend

    async def _close_all(self) -> None:
        self._models_generation += 1
        # a reload of the models loads the installed version as it is then: the next check compares every module
        # again, so an update that came while a load was cut off is not missed
        self._modules_version = -1
        await asyncio.gather(
            *(d.close() for d in self.object_detectors.values()),
            *(d.close() for d in self.face_detectors.values()),
            *(d.close() for d in self.plate_detectors.values()),
            *(e.close() for e in self.face_embedders.values()),
            *(e.close() for e in self.clip_encoders.values()),
            *(o.close() for o in self.ocr_models.values()),
            *(e.close() for e in self.person_embedders.values()),
            *(s.close() for s in self.segmenters.values()),
        )
        for backend in self.attribute_backends.values():
            backend.close()
        self.attribute_backends.clear()
        self.object_detectors.clear()
        self.face_detectors.clear()
        self.face_embedders.clear()
        self.plate_detectors.clear()
        self.ocr_models.clear()
        self.clip_encoders.clear()
        self.person_embedders.clear()
        self.segmenters.clear()

    async def _on_start(self) -> None:
        asyncio.create_task(self._preload_clip())
        self._modules_watch = asyncio.create_task(self._watch_modules())

    async def _preload_clip(self) -> None:
        try:
            await self.get_clip_encoder(self.clip_model())
            self.logger.log("Модели CLIP предзагружены")
        except Exception as e:
            self.logger.error(f"Не удалось предзагрузить модели CLIP: {e}")

    async def _on_shutdown(self) -> None:
        if self._modules_watch:
            self._modules_watch.cancel()
        for sensors in self._sensors.values():
            for sensor in sensors.values():
                await sensor.destroy()
        self._sensors.clear()

        await self._close_all()


def __main__() -> type[ONNXPlugin]:
    return ONNXPlugin
