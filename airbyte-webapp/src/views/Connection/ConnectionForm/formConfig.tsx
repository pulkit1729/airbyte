import { useMemo } from "react";
import { useIntl } from "react-intl";
import * as yup from "yup";

import { DropDownRow } from "components";

import FrequencyConfig from "config/FrequencyConfig.json";
import { SyncMode, SyncSchema, SyncSchemaStream } from "core/domain/catalog";
import {
  isDbtTransformation,
  isNormalizationTransformation,
  NormalizationType,
  OperatorType,
  Transformation,
} from "core/domain/connection/operation";
import { SOURCE_NAMESPACE_TAG } from "core/domain/connector/source";
import { ValuesProps } from "hooks/services/useConnectionHook";
import { useCurrentWorkspace } from "services/workspaces/WorkspacesService";

import {
  ConnectionSchedule,
  DestinationDefinitionSpecificationRead,
  DestinationSyncMode,
  NamespaceDefinitionType,
  OperationRead,
  WebBackendConnectionRead,
} from "../../../core/request/AirbyteClient";
import { getOptimalSyncMode, verifyConfigCursorField, verifySupportedSyncModes } from "./formConfigHelpers";

type FormikConnectionFormValues = {
  schedule?: ConnectionSchedule | null;
  prefix: string;
  syncCatalog: SyncSchema;
  namespaceDefinition?: NamespaceDefinitionType;
  namespaceFormat: string;
  transformations?: Transformation[];
  normalization?: NormalizationType;
};

type ConnectionFormValues = ValuesProps;

const SUPPORTED_MODES: [SyncMode, DestinationSyncMode][] = [
  [SyncMode.FullRefresh, DestinationSyncMode.overwrite],
  [SyncMode.FullRefresh, DestinationSyncMode.append],
  [SyncMode.Incremental, DestinationSyncMode.append],
  [SyncMode.Incremental, DestinationSyncMode.append_dedup],
];

const DEFAULT_SCHEDULE: ConnectionSchedule = {
  units: 24,
  timeUnit: "hours",
};

function useDefaultTransformation(): Transformation {
  const workspace = useCurrentWorkspace();
  return {
    operationId: "", // TODO: Does this need a value?
    name: "My dbt transformations",
    workspaceId: workspace.workspaceId,
    operatorConfiguration: {
      operatorType: OperatorType.Dbt,
      dbt: {
        gitRepoUrl: "", // TODO: Does this need a value?
        dockerImage: "fishtownanalytics/dbt:0.19.1",
        dbtArguments: "run",
      },
    },
  };
}

const connectionValidationSchema = yup
  .object({
    schedule: yup
      .object({
        units: yup.number().required("form.empty.error"),
        timeUnit: yup.string().required("form.empty.error"),
      })
      .nullable()
      .defined("form.empty.error"),
    namespaceDefinition: yup
      .string()
      .oneOf([
        NamespaceDefinitionType.source,
        NamespaceDefinitionType.destination,
        NamespaceDefinitionType.customformat,
      ])
      .required("form.empty.error"),
    namespaceFormat: yup.string().when("namespaceDefinition", {
      is: NamespaceDefinitionType.customformat,
      then: yup.string().required("form.empty.error"),
    }),
    prefix: yup.string(),
    syncCatalog: yup.object({
      streams: yup.array().of(
        yup.object({
          id: yup
            .string()
            // This is required to get rid of id fields we are using to detect stream for edition
            .when("$isRequest", (isRequest: boolean, schema: yup.StringSchema) =>
              isRequest ? schema.strip(true) : schema
            ),
          stream: yup.object(),
          config: yup
            .object({
              selected: yup.boolean(),
              syncMode: yup.string(),
              destinationSyncMode: yup.string(),
              primaryKey: yup.array().of(yup.array().of(yup.string())),
              cursorField: yup.array().of(yup.string()).defined(),
            })
            .test({
              name: "connectionSchema.config.validator",
              // eslint-disable-next-line no-template-curly-in-string
              message: "${path} is wrong",
              test: function (value) {
                if (!value.selected) {
                  return true;
                }
                if (DestinationSyncMode.append_dedup === value.destinationSyncMode) {
                  // it's possible that primaryKey array is always present
                  // however yup couldn't determine type correctly even with .required() call
                  if (value.primaryKey?.length === 0) {
                    return this.createError({
                      message: "connectionForm.primaryKey.required",
                      path: `schema.streams[${this.parent.id}].config.primaryKey`,
                    });
                  }
                }

                if (SyncMode.Incremental === value.syncMode) {
                  if (
                    !this.parent.stream.sourceDefinedCursor &&
                    // it's possible that cursorField array is always present
                    // however yup couldn't determine type correctly even with .required() call
                    value.cursorField?.length === 0
                  ) {
                    return this.createError({
                      message: "connectionForm.cursorField.required",
                      path: `schema.streams[${this.parent.id}].config.cursorField`,
                    });
                  }
                }
                return true;
              },
            }),
        })
      ),
    }),
  })
  .noUnknown();

/**
 * Returns {@link Operation}[]
 *
 * Maps UI representation of Transformation and Normalization
 * into API's {@link Operation} representation.
 *
 * Always puts normalization as first operation
 * @param values
 * @param initialOperations
 * @param workspaceId
 */
function mapFormPropsToOperation(
  values: {
    transformations?: Transformation[];
    normalization?: NormalizationType;
  },
  initialOperations: OperationRead[] = [],
  workspaceId: string
): OperationRead[] {
  const newOperations: OperationRead[] = [];

  if (values.normalization) {
    if (values.normalization !== NormalizationType.RAW) {
      const normalizationOperation = initialOperations.find(isNormalizationTransformation);

      if (normalizationOperation) {
        newOperations.push(normalizationOperation);
      } else {
        newOperations.push({
          name: "Normalization",
          workspaceId,
          operationId: "", // TODO: Is this necessary?
          operatorConfiguration: {
            operatorType: OperatorType.Normalization,
            normalization: {
              option: values.normalization,
            },
          },
        });
      }
    }
  }

  if (values.transformations) {
    newOperations.push(...values.transformations);
  }

  return newOperations;
}
const useInitialSchema = (
  schema: SyncSchema,
  supportedDestinationSyncModes: DestinationSyncMode[] | undefined
): SyncSchema =>
  useMemo<SyncSchema>(
    () => ({
      streams: schema.streams
        .map((apiNode, id) => {
          const nodeWithId: SyncSchemaStream = { ...apiNode, id: id.toString() };
          const nodeStream = verifyConfigCursorField(verifySupportedSyncModes(nodeWithId));

          return getOptimalSyncMode(nodeStream, supportedDestinationSyncModes);
        })
        .filter((stream): stream is SyncSchemaStream => Boolean(stream)),
    }),
    [schema.streams, supportedDestinationSyncModes]
  );

const getInitialTransformations = (operations?: OperationRead[]): Transformation[] =>
  operations?.filter(isDbtTransformation) ?? [];

const getInitialNormalization = (operations?: OperationRead[], isEditMode?: boolean): NormalizationType => {
  let initialNormalization =
    operations?.find(isNormalizationTransformation)?.operatorConfiguration?.normalization?.option;

  // If no normalization was selected for already present normalization -> select Raw one
  if (!initialNormalization && isEditMode) {
    initialNormalization = undefined;
  }

  return initialNormalization ?? NormalizationType.BASIC;
};

const useInitialValues = (
  connection:
    | WebBackendConnectionRead
    | (Partial<WebBackendConnectionRead> & Pick<WebBackendConnectionRead, "syncCatalog" | "source" | "destination">),
  destDefinition: DestinationDefinitionSpecificationRead,
  isEditMode?: boolean
): FormikConnectionFormValues => {
  const initialSchema = useInitialSchema(connection.syncCatalog, destDefinition.supportedDestinationSyncModes);

  return useMemo(() => {
    const initialValues: FormikConnectionFormValues = {
      syncCatalog: initialSchema,
      schedule: connection.schedule !== undefined ? connection.schedule : DEFAULT_SCHEDULE,
      prefix: connection.prefix || "",
      namespaceDefinition: connection.namespaceDefinition || NamespaceDefinitionType.source,
      namespaceFormat: connection.namespaceFormat ?? SOURCE_NAMESPACE_TAG,
    };

    const operations = connection.operations ?? [];

    if (destDefinition.supportsDbt) {
      initialValues.transformations = getInitialTransformations(operations);
    }

    if (destDefinition.supportsNormalization) {
      initialValues.normalization = getInitialNormalization(operations, isEditMode);
    }

    return initialValues;
  }, [initialSchema, connection, isEditMode, destDefinition]);
};

const useFrequencyDropdownData = (): DropDownRow.IDataItem[] => {
  const { formatMessage } = useIntl();

  return useMemo(
    () =>
      FrequencyConfig.map((item) => ({
        value: item.config,
        label:
          item.config === null
            ? item.text
            : formatMessage(
                {
                  id: "form.every",
                },
                {
                  value: item.simpleText || item.text,
                }
              ),
      })),
    [formatMessage]
  );
};

export type { ConnectionFormValues, FormikConnectionFormValues };
export {
  connectionValidationSchema,
  useInitialValues,
  useFrequencyDropdownData,
  mapFormPropsToOperation,
  SUPPORTED_MODES,
  useDefaultTransformation,
  getInitialNormalization,
  getInitialTransformations,
};
