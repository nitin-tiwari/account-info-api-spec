const parse = require('csv-parse/lib/sync'); // eslint-disable-line
const fs = require('fs');
const flatten = require('flatten');
const { YAML } = require('swagger-parser'); // eslint-disable-line

const commonTypes = [ // eslint-disable-line
  'OBRisk2',
  'Links',
  'ISODateTime',
  'Meta',
];

const embedDescription = klass =>
  [
    'OBCashAccount1',
    'OBBranchAndFinancialInstitutionIdentification2',
    'OBCreditDebitCode',
    'OBCashAccount2',
  ].includes(klass);

const assign = (schema, obj) => Object.assign(schema, obj);

const classFor = (property) => {
  const type = property.Class;
  const name = property.Name;

  if (type && type.endsWith('Text')) {
    return name;
  } else if (type && (
    type === 'ISODateTime'
  )) {
    return `${name}_${type}`;
  } else if (
    type === 'xs:boolean' ||
    type === 'xs:string' ||
    type === 'xs:ID'
  ) {
    return name;
  } else if (
    type === 'ActiveOrHistoricCurrencyAndAmount' ||
    type === 'ActiveOrHistoricCurrencyCode'
  ) { // # aka rule 3
    const path = property.XPath.split('/');
    const parent = path[path.length - 2];
    return `${parent}_${type}`;
  } else if (type === 'ActiveOrHistoricCurrencyAndAmount') { // # aka rule 4
    const path = property.XPath.split('/');
    const parent = path[path.length - 2];
    return `${parent}_${name}_${type}`;
  }
  return type;
};

const typeFor = (property) => {
  const type = property.Class;
  if (type && (
    type === 'ISODateTime' ||
    type === 'xs:string' ||
    type === 'xs:ID' ||
    type.endsWith('Text') ||
    type.endsWith('Code')
  )) {
    return 'string';
  } else if (type === 'xs:boolean') {
    return 'boolean';
  }
  return 'object';
};

const enumFor = (property) => {
  if (property.Codes) {
    return { enum: property.Codes.split('\n') };
  }
  return null;
};

const minOccurrenceFor = (property) => {
  if (property.Occurrence === '1..n') {
    return 1;
  }
  if (property.Occurrence === '0..n') {
    return 0;
  }
  return null;
};

const formatFor = (property) => {
  if (property.Class === 'ISODateTime') {
    return { format: 'date-time' };
  }
  return null;
};

const descriptionFor = (property, isoDescription) => {
  if (property.EnhancedDefinition) {
    let description = property.EnhancedDefinition.replace(/\n{2,}/g, '\n');
    if (property.Class === 'ISODateTime') {
      description = `${description}\n${isoDescription}`;
    }
    return { description };
  }
  return null;
};

const itemsFor = (property, isoDescription) => ({
  items: assign(
    descriptionFor(property, isoDescription),
    { type: 'string' },
    enumFor(property),
  ),
});

const useSeparateDefinition = (klass, name, separateDefinitions = []) =>
  (
    klass.startsWith('OB') &&
    (
      !klass.startsWith('OBReadData')
      || ['OBReadData1', 'OBReadDataResponse1'].includes(klass)
    )
  ) ||
  (
    separateDefinitions.includes(name) &&
    klass !== 'ActiveOrHistoricCurrencyAndAmount'
  );

const isArray = p => p.Occurrence && p.Occurrence.endsWith('..n');

const arrayProperty = (ref, p, isoDescription) => {
  const obj = {
    items: ref,
    type: 'array',
  };
  if (descriptionFor(p, isoDescription)) {
    assign(obj, descriptionFor(p, isoDescription));
  }
  if (minOccurrenceFor(p)) {
    assign(obj, { minItems: minOccurrenceFor(p) });
  }
  return obj;
};

const refPlusDescription = (ref, p, isoDescription) => ({
  allOf: [
    ref,
    descriptionFor(p, isoDescription),
  ],
});

const propertyRef = (klass, p, isoDescription) => {
  const ref = { $ref: `#/definitions/${klass}` };
  if (isArray(p)) {
    return arrayProperty(ref, p);
  } else if (embedDescription(klass)) {
    return refPlusDescription(ref, p, isoDescription);
  }
  return ref;
};

const propertyDef = (p, childSchemas, separateDefinitions, isoDescription) => {
  const klass = classFor(p);
  if (useSeparateDefinition(p.Class, p.Name, separateDefinitions) || !childSchemas) {
    return propertyRef(klass, p, isoDescription);
  }
  const schema = childSchemas.filter(s => Object.keys(s)[0] === klass)[0];
  return Object.values(schema)[0]; // eslint-disable-line
};

const propertiesObj = (list, key, childSchemas, separateDefinitions = [], isoDescription) => {
  const obj = {};
  list.forEach((p) => {
    obj[p.Name] = propertyDef(p, childSchemas, separateDefinitions, isoDescription);
  });
  if (key && key.endsWith('ActiveOrHistoricCurrencyAndAmount') && !obj.Amount) {
    return assign({ Amount: { $ref: '#/definitions/Amount' } }, obj);
  }
  return obj;
};

const requiredProp = (list, key) => {
  const required = list.filter(p => !p.Occurrence.startsWith('0'));
  const requiredList = required.map(p => p.Name);
  if (key.endsWith('ActiveOrHistoricCurrencyAndAmount') &&
    !requiredList.includes('Amount')) {
    return ['Amount'].concat(requiredList);
  }
  return requiredList;
};

const maxPattern = /Max(\d+)\D/;

const maxLengthFor = (property) => {
  const maxMatch = maxPattern.exec(property.Class);
  if (maxMatch) {
    return parseInt(maxMatch[1], 10);
  }
  return null;
};

const minPattern = /Min(\d+)\D/;

const minLengthFor = (property) => {
  const minMatch = minPattern.exec(property.Class);
  if (minMatch) {
    return parseInt(minMatch[1], 10);
  }
  return 1;
};

const patternFor = (property) => {
  const pattern = property.Pattern;
  if (pattern &&
    pattern.length > 0 &&
    pattern.indexOf('TotalDigits') === -1) {
    return { pattern: property.Pattern };
  }
  return null;
};

const topLevelFilter = row => row.XPath.split('/').length === 2;

const nextLevelPattern = p => new RegExp(`^${p.XPath}/[^/]+$`);

const nextLevelFilter = p => row => row.XPath.match(nextLevelPattern(p));

const detailPermissionProperties = (permissions, property, properties) => {
  const list = (permissions && permissions.filter(p => p.XPath.startsWith(property.XPath))) || [];
  const detailXPaths = list.map(p => p.XPath);
  const detailProperties = properties.filter(p => detailXPaths.includes(p.XPath));
  return detailProperties;
};

const mandatoryForKey = (key) => {
  if (key === 'OBAccount1') {
    return ['Account'];
  }
  return [];
};

const extendBasicPropertiesObj = (key, detailProperties, separateDefinitions, isoDescription) => ({
  allOf: [
    { $ref: `#/definitions/${key}Basic` },
    {
      properties: propertiesObj(detailProperties, key, null, separateDefinitions, isoDescription),
    },
  ],
});

const makeDetailSchema = (key) => {
  const required = mandatoryForKey(key);
  const label = `${key}Detail`;
  const detail = {
    [label]: {
      allOf: [
        { $ref: `#/definitions/${key}` },
      ],
    },
  };
  if (required.length > 0) {
    detail[label].allOf.push({ required });
  }
  return detail;
};

const makeSchema = (
  property, rows, propertyFilter, permissions,
  separateDefinitions, isoDescription, definedProperties = [],
) => {
  const obj = {};
  const properties = rows.filter(propertyFilter || nextLevelFilter(property));
  const detailProperties = detailPermissionProperties(permissions, property, properties);
  const schema = {};
  const key = classFor(property);
  if (useSeparateDefinition(property.Class, property.Name, separateDefinitions)
    && !embedDescription(key)) {
    definedProperties.push({
      xpath: property.XPath, key, description: property.EnhancedDefinition,
    }); // eslint-disable-line
  }
  const type = typeFor(property);

  const childSchemas = flatten(properties.map(p =>
    makeSchema(p, rows, null, permissions, separateDefinitions, isoDescription, definedProperties))); // eslint-disable-line

  if (descriptionFor(property) && !embedDescription(key)) {
    assign(schema, descriptionFor(property, isoDescription));
  }
  assign(schema, { type });
  if (type === 'object') {
    if (detailProperties.length > 0) {
      assign(schema, extendBasicPropertiesObj(key, detailProperties, separateDefinitions, isoDescription)); // eslint-disable-line
    } else {
      const childProperties = propertiesObj(properties, key, childSchemas, separateDefinitions, isoDescription); // eslint-disable-line
      assign(schema, { properties: childProperties });
      if (requiredProp(properties, key).length > 0) {
        assign(schema, { required: requiredProp(properties, key) });
      }
      assign(schema, { additionalProperties: false });
    }
  }
  if (type === 'array') {
    assign(schema, itemsFor(property, isoDescription));
  } else if (property.Codes && property.Codes.length > 0) {
    assign(schema, enumFor(property));
  }
  if (minOccurrenceFor(property) && type === 'object') {
    assign(schema, {
      minProperties: minOccurrenceFor(property),
    });
  }
  if (maxLengthFor(property)) {
    assign(schema, {
      minLength: minLengthFor(property),
      maxLength: maxLengthFor(property),
    });
  }
  if (formatFor(property)) {
    assign(schema, formatFor(property));
  }
  if (patternFor(property)) {
    assign(schema, patternFor(property));
  }
  obj[key] = schema;
  const schemas = [];
  if (schema.allOf) {
    const base = makeSchema(property, rows, null, [], separateDefinitions, isoDescription);
    const baseSchema = Object.values(base[0])[0];
    const detailKeys = Object.keys(schema.allOf[1].properties);
    detailKeys.forEach((k) => { delete baseSchema.properties[k]; });
    schemas.push({ [`${key}Basic`]: baseSchema });
    delete obj[key].type; // type is on base schema
    delete obj[key].description; // description is on base schema
    schemas.push(obj);
    schemas.push(makeDetailSchema(key));
  } else {
    obj.property = property;
    schemas.push(obj);
  }
  schemas.push(childSchemas);
  if (key.endsWith('ActiveOrHistoricCurrencyAndAmount')) {
    schemas.push({
      Amount: {
        type: 'string',
        pattern: '^\\d{1,13}\\.\\d{1,5}$',
      },
    });
  }
  return schemas;
};

const convertRows = (rows, permissions, separateDefinitions = [], isoDescription, definedProperties = []) => { // eslint-disable-line
  const schemas = flatten(makeSchema(
    rows[0], rows, topLevelFilter, permissions,
    separateDefinitions, isoDescription, definedProperties,
  ));
  const filtered = schemas.filter((s) => {
    const key = Object.keys(s)[0];
    const { property } = s;
    if (property) {
      return useSeparateDefinition(property.Class, property.Name, separateDefinitions);
    }
    return useSeparateDefinition(key, key, separateDefinitions);
  });
  return filtered;
};

const normalizeHeaders = text => Buffer.from(text, 'utf-8')
  .toString('utf-8')
  .replace(/"Composition or Attribute\//g, '"')
  .replace(/"Notes\//g, '"')
  .replace(/"Class, data type of a composition or attribute\/Name/g, '"Class')
  .replace(/"Class, data type of a composition or attribute\//g, '"');

const parseCsv = (file) => {
  const text = fs.readFileSync(file);
  const lines = parse(normalizeHeaders(text), { columns: true, delimiter: ';' });
  return lines;
};

const schemaFile = (key, outdir) => {
  const defDir = `${outdir}/accounts/definitions`;
  if (!fs.existsSync(defDir)) {
    fs.mkdirSync(defDir);
  }
  const outFile = `${defDir}/${key}.yaml`;
  console.log(outFile);
  return outFile;
};

const convertCSV = (dir, file, outdir, permissions, separateDefinitions, isoDescription, definedProperties) => { // eslint-disable-line
  console.log('==='); // eslint-disable-line
  console.log(file); // eslint-disable-line
  console.log('---'); // eslint-disable-line
  const lines = parseCsv(file);
  // console.log(JSON.stringify(lines, null, 2)); // eslint-disable-line
  const schemas = convertRows(lines, permissions, separateDefinitions, isoDescription, definedProperties); // eslint-disable-line
  schemas.forEach((schema) => {
    const key = Object.keys(schema)[0];
    if (!commonTypes.includes(key)) {
      const outFile = schemaFile(key, outdir);
      if (schema.property) {
        delete schema.property; // eslint-disable-line
      }
      fs.writeFileSync(outFile, YAML.stringify(schema));
    }
  });
};

const readYaml = file => YAML.parse(fs.readFileSync(file));

const convertCSVs = (dir, outdir, separateDefinitions) => {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.csv')
    && f !== 'Enumerations.csv'
    && f !== 'Permissions.csv');
  const permissionsFile = `${dir}/Permissions.csv`;
  const permissions = parseCsv(permissionsFile);
  const definedProperties = [];
  const isoDescription = readYaml(`${outdir}/readwrite/definitions/ISODateTime.yaml`).ISODateTime.description;
  files.forEach(file =>
    convertCSV(dir, `${dir}/${file}`, outdir, permissions, separateDefinitions, isoDescription, definedProperties));
  console.log(YAML.stringify(definedProperties)); // eslint-disable-line
  const keyToDescription = [];
  definedProperties.forEach((x) => {
    const { key, description } = x;
    keyToDescription[key] = (keyToDescription[key] || new Set()).add(description);
  });
  const descriptions = Object.keys(keyToDescription).map(key => ({
    key,
    d: Array.from(keyToDescription[key]),
  }));
  const dups = descriptions.filter(x => x.d.length > 1);
  if (dups.length > 0) {
    console.log(JSON.stringify(dups, null, 2)); // eslint-disable-line
    console.log('dup keys count:' + dups.length); // eslint-disable-line
    dups.forEach((dup) => {
      const { key } = dup;
      try {
        const file = schemaFile(key, outdir);
        console.log(`delete: ${file}`);
        fs.unlinkSync(file);
      } catch (e) {
        console.log(e.message);
      }
    });
  }
};

exports.makeSchema = makeSchema;
exports.convertCSV = convertCSV;
exports.convertCSVs = convertCSVs;
exports.convertRows = convertRows;
exports.classFor = classFor;
exports.typeFor = typeFor;
