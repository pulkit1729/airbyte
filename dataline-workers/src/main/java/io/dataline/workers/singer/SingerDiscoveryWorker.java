package io.dataline.workers.singer;

import io.dataline.workers.DiscoveryOutput;
import java.io.File;
import java.io.IOException;
import java.util.UUID;

public class SingerDiscoveryWorker extends BaseSingerWorker<DiscoveryOutput> {
  private static String CONFIG_JSON_FILENAME = "config.json";
  private static String CATALOG_JSON_FILENAME = "catalog.json";
  private static String ERROR_LOG_FILENAME = "err.log";

  private final String configDotJson;
  private final SingerTap tap;
  private DiscoveryOutput output;

  public SingerDiscoveryWorker(
      String configDotJson, SingerTap tap, String workspaceRoot, String singerLibsRoot) {
    // TODO Worker ID should probably be an input from the scheduler for easier debugging
    super(UUID.randomUUID().toString(), workspaceRoot, singerLibsRoot);
    this.configDotJson = configDotJson;
    this.tap = tap;
  }

  @Override
  protected Process runInternal() {
    // write config.json to disk
    // TODO use format converter here
    String configPath = writeFileToWorkspace(CONFIG_JSON_FILENAME, configDotJson);

    String tapPath = getExecutableAbsolutePath(tap);

    String catalogDotJsonPath =
        getWorkspacePath().resolve(CATALOG_JSON_FILENAME).toAbsolutePath().toString();
    String errorLogPath =
        getWorkspacePath().resolve(ERROR_LOG_FILENAME).toAbsolutePath().toString();
    // exec
    try {
      return new ProcessBuilder(tapPath, "--config " + configPath, "--discover")
          .redirectError(new File(errorLogPath))
          .redirectOutput(new File(catalogDotJsonPath))
          .start();
    } catch (IOException e) {
      throw new RuntimeException(e);
    }
  }

  @Override
  public DiscoveryOutput getOutputInternal() {
    String catalog = readFileFromWorkspace(CATALOG_JSON_FILENAME);
    return new DiscoveryOutput(catalog);
  }
}
