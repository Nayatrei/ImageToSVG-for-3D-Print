import {
    BAMBU_PROJECT_NOZZLE_DIAMETER
} from '../config.js';

const DEFAULT_LAYER_HEIGHT = 0.2;
const DEFAULT_BED_TYPE = 'textured_plate';
const DEFAULT_BED_LABEL = 'Textured PEI Plate';

export const BAMBU_PRINTER_TEMPLATES = {
    x1: {
        bedKey: 'x1',
        printerModel: 'Bambu Lab X1 Carbon',
        printerSettingsId: 'Bambu Lab X1 Carbon 0.4 nozzle',
        printCompatiblePrinters: ['Bambu Lab X1 Carbon 0.4 nozzle'],
        printerStructure: 'corexy',
        printerTechnology: 'FFF',
        printerVariant: '0.4',
        printerExtruderVariant: 'Direct Drive Standard',
        printableArea: ['0x0', '256x0', '256x256', '0x256'],
        bedType: DEFAULT_BED_TYPE,
        currBedType: DEFAULT_BED_LABEL,
        defaultFilamentProfile: 'Generic PLA @BBL X1C',
        defaultFilamentType: 'PLA',
        defaultNozzleTemperature: '220',
        defaultBedTemperature: '55'
    },
    a1: {
        bedKey: 'a1',
        printerModel: 'Bambu Lab A1',
        printerSettingsId: 'Bambu Lab A1 0.4 nozzle',
        printCompatiblePrinters: ['Bambu Lab A1 0.4 nozzle'],
        printerStructure: 'i3',
        printerTechnology: 'FFF',
        printerVariant: '0.4',
        printerExtruderVariant: 'Direct Drive Standard',
        printableArea: ['0x0', '256x0', '256x256', '0x256'],
        bedType: DEFAULT_BED_TYPE,
        currBedType: DEFAULT_BED_LABEL,
        defaultFilamentProfile: 'Generic PLA @BBL A1',
        defaultFilamentType: 'PLA',
        defaultNozzleTemperature: '220',
        defaultBedTemperature: '55'
    },
    a1mini: {
        bedKey: 'a1mini',
        printerModel: 'Bambu Lab A1 mini',
        printerSettingsId: 'Bambu Lab A1 mini 0.4 nozzle',
        printCompatiblePrinters: ['Bambu Lab A1 mini 0.4 nozzle'],
        printerStructure: 'i3',
        printerTechnology: 'FFF',
        printerVariant: '0.4',
        printerExtruderVariant: 'Direct Drive Standard',
        printableArea: ['0x0', '180x0', '180x180', '0x180'],
        bedType: DEFAULT_BED_TYPE,
        currBedType: DEFAULT_BED_LABEL,
        defaultFilamentProfile: 'Generic PLA @BBL A1M',
        defaultFilamentType: 'PLA',
        defaultNozzleTemperature: '220',
        defaultBedTemperature: '55'
    },
    h2d: {
        bedKey: 'h2d',
        printerModel: 'Bambu Lab H2D',
        printerSettingsId: 'Bambu Lab H2D 0.4 nozzle',
        printCompatiblePrinters: ['Bambu Lab H2D 0.4 nozzle'],
        printerStructure: 'cartesian',
        printerTechnology: 'FFF',
        printerVariant: '0.4',
        printerExtruderVariant: 'Direct Drive Standard',
        printableArea: ['0x0', '325x0', '325x320', '0x320'],
        bedType: DEFAULT_BED_TYPE,
        currBedType: DEFAULT_BED_LABEL,
        defaultFilamentProfile: 'Generic PLA @BBL H2D',
        defaultFilamentType: 'PLA',
        defaultNozzleTemperature: '220',
        defaultBedTemperature: '55'
    }
};

export function getBambuPrinterTemplate(bedKey = 'x1') {
    return BAMBU_PRINTER_TEMPLATES[bedKey] || BAMBU_PRINTER_TEMPLATES.x1;
}

export function buildBambuProjectSettings({
    template,
    title,
    layerCount,
    filamentColors,
    nozzleDiameter = BAMBU_PROJECT_NOZZLE_DIAMETER
}) {
    const colors = (Array.isArray(filamentColors) ? filamentColors : []).map((color) => String(color || '#FFFFFF').toUpperCase());
    const count = Math.max(1, layerCount || colors.length || 1);
    const normalizedColors = Array.from({ length: count }, (_, index) => colors[index] || colors[colors.length - 1] || '#FFFFFF');
    const filamentProfiles = normalizedColors.map((_, index) => `Genesis Layer ${index + 1} @ ${template.printerSettingsId}`);
    const filamentIds = normalizedColors.map((_, index) => `GENESIS_${String(index + 1).padStart(2, '0')}`);
    const filamentMap = normalizedColors.map((_, index) => String(index + 1));
    const nozzleList = normalizedColors.map(() => String(nozzleDiameter.toFixed(1)));
    const tempList = normalizedColors.map(() => template.defaultNozzleTemperature);
    const bedTempList = normalizedColors.map(() => template.defaultBedTemperature);

    return {
        title,
        printable_area: template.printableArea,
        printer_model: template.printerModel,
        printer_settings_id: template.printerSettingsId,
        print_compatible_printers: template.printCompatiblePrinters,
        printer_variant: template.printerVariant,
        printer_structure: template.printerStructure,
        printer_technology: template.printerTechnology,
        printer_extruder_variant: [template.printerExtruderVariant],
        printer_extruder_id: ['1'],
        extruder_max_nozzle_count: ['1'],
        extruder_nozzle_stats: [`Standard#${count}`],
        curr_bed_type: template.currBedType,
        bed_exclude_area: [],
        bed_custom_model: '',
        bed_custom_texture: '',
        bed_temperature_formula: 'by_first_filament',
        bed_type: template.bedType,
        cool_plate_temp: bedTempList,
        cool_plate_temp_initial_layer: bedTempList,
        eng_plate_temp: bedTempList,
        eng_plate_temp_initial_layer: bedTempList,
        hot_plate_temp: bedTempList,
        hot_plate_temp_initial_layer: bedTempList,
        textured_plate_temp: bedTempList,
        textured_plate_temp_initial_layer: bedTempList,
        supertack_plate_temp: bedTempList,
        supertack_plate_temp_initial_layer: bedTempList,
        default_filament_profile: [template.defaultFilamentProfile],
        default_filament_colour: [''],
        default_nozzle_volume_type: ['Standard'],
        filament_settings_id: filamentProfiles,
        filament_colour: normalizedColors,
        filament_multi_colour: normalizedColors,
        filament_colour_type: normalizedColors.map(() => '1'),
        filament_type: normalizedColors.map(() => template.defaultFilamentType),
        filament_vendor: normalizedColors.map(() => 'Genesis Image Tools'),
        filament_ids: filamentIds,
        filament_map: filamentMap,
        filament_map_mode: 'Auto For Flush',
        filament_nozzle_map: normalizedColors.map(() => '0'),
        filament_printable: normalizedColors.map(() => '1'),
        filament_is_support: normalizedColors.map(() => '0'),
        filament_extruder_variant: normalizedColors.map(() => template.printerExtruderVariant),
        filament_density: normalizedColors.map(() => '1.24'),
        filament_diameter: normalizedColors.map(() => '1.75'),
        filament_flow_ratio: normalizedColors.map(() => '1'),
        filament_max_volumetric_speed: normalizedColors.map(() => '12'),
        filament_notes: '',
        nozzle_diameter: nozzleList,
        nozzle_temperature: tempList,
        nozzle_temperature_initial_layer: tempList,
        nozzle_temperature_range_high: normalizedColors.map(() => '260'),
        nozzle_temperature_range_low: normalizedColors.map(() => '190'),
        nozzle_type: normalizedColors.map(() => 'stainless_steel'),
        printer_notes: '',
        print_sequence: 'by layer',
        machine_gcode_flavor: 'bambu',
        machine_max_acceleration_e: Array.from({ length: Math.max(2, count) }, () => '5000'),
        machine_load_filament_time: 28,
        machine_unload_filament_time: 34,
        change_filament_gcode: '',
        template_custom_gcode: '',
        wall_filament: 0,
        sparse_infill_filament: 0,
        solid_infill_filament: 0,
        support_filament: 0,
        support_interface_filament: 0,
        first_layer_print_sequence: 'by layer',
        layer_height: String(DEFAULT_LAYER_HEIGHT),
        initial_layer_print_height: String(DEFAULT_LAYER_HEIGHT),
        line_width: String(nozzleDiameter),
        nozzle_volume_type: ['Standard']
    };
}
