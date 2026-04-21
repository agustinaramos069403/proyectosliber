# Sheets para plus y precios

Estos CSV están listos para importar a Google Sheets (Archivo → Importar → Subir → Reemplazar hoja o Insertar hojas nuevas).

## 1) Obras sociales + plus

- **Archivo**: `HealthInsurancePlus.csv`
- **Columnas**:
  - `City`: Corrientes / Resistencia / Formosa / Saenz Pena
  - `HealthInsuranceName`: nombre tal cual lo escriba la secretaría
  - `IsAccepted`: TRUE/FALSE
  - `HasPlus`: TRUE/FALSE
  - `PlusAmountArs`: número (ej. 35000)
  - `Notes`: opcional

## 2) Precio particular por ciudad

- **Archivo**: `PrivatePrices.csv`
- **Columnas**:
  - `City`
  - `PrivatePriceArs`
  - `Notes`

## Recomendación práctica

- Que el Dr./secretaría editen **solo** `PlusAmountArs` y `PrivatePriceArs` cuando cambie el valor.
- Si agregan/quitan obras sociales, sumar/quitar filas en `HealthInsurancePlus`.
