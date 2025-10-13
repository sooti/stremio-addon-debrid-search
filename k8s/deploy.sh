#!/bin/bash

# This script automates the deployment of the sootio application to Kubernetes.

# --- Configuration ---
#
# The script uses an environment variable for the Docker image name.
# Before running, please set the IMAGE_NAME environment variable.
# For example:
#   export IMAGE_NAME="your-dockerhub-username/sootio:latest"
#

set -e

# --- Functions ---

# Function to print usage instructions
usage() {
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "A script to automate the deployment of the sootio application to Kubernetes."
    echo ""
Options:
    echo "  --push-image        Build and push the Docker image before deploying. Default is to not push."
    echo "  --no-port-forward   Do not run kubectl port-forward after deployment. Default is to run it."
    echo "  --help              Display this help message."
    echo ""
    echo "Prerequisites:"
    echo "  - Docker must be installed and running."
    echo "  - kubectl must be installed and configured to connect to your Kubernetes cluster."
    echo "  - The script defaults to using 'sooti/sootio:latest' as the image name."
    echo "    You can override this by setting the IMAGE_NAME environment variable."
    echo "    (e.g., export IMAGE_NAME=\"your-username/sootio:latest\")"
}

# --- Argument Parsing ---

PUSH_IMAGE=false
NO_PORT_FORWARD=false

while [[ "$#" -gt 0 ]]; do
    case "$1" in
        --push-image)
            PUSH_IMAGE=true
            shift
            ;;
        --no-port-forward)
            NO_PORT_FORWARD=true
            shift
            ;;
        --help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done
# --- Pre-flight Checks ---

# Check if docker is installed
if ! command -v docker &> /dev/null; then
    echo "Error: docker is not installed. Please install Docker and try again."
    exit 1
fi

# Check if kubectl is installed
if ! command -v kubectl &> /dev/null; then
    echo "Error: kubectl is not installed. Please install kubectl and try again."
    exit 1
fi

# Check if IMAGE_NAME is set, otherwise use a default
if [ -z "$IMAGE_NAME" ]; then
    echo "INFO: IMAGE_NAME environment variable not set. Using default: sooti/sootio:latest"
    IMAGE_NAME="sooti/sootio:latest"
fi

# --- Script ---

# Change to the project root directory
cd "$(dirname "$0")"/.. || exit

if [ "$PUSH_IMAGE" = true ]; then
    echo "Starting deployment with image build and push..."

    # 1. Build the Docker image
    echo "Building Docker image: $IMAGE_NAME..."
    docker build -t "$IMAGE_NAME" .

    # 2. Push the Docker image
    echo "Pushing Docker image to $IMAGE_NAME..."
    docker push "$IMAGE_NAME"
else
    echo "Skipping image build and push..."
fi

# read .env if present and export variables (so PORT can be used)
if [ -f .env ]; then
  echo "Loading .env and exporting variables for manifest templating..."
  # Export variables from .env (ignore comments/empty lines)
  set -o allexport
  # shellcheck disable=SC1090
  source <(grep -v '^\s*#' .env | sed -E 's/\r$//')
  set +o allexport
else
  echo "No .env file found in project root; continuing with defaults."
fi

# Ensure PORT set (or default 6907)
PORT="${PORT:-6907}"
# Validate PORT is integer
if ! printf '%s' "$PORT" | grep -Eq '^[0-9]+$'; then
  echo "ERROR: PORT value '${PORT}' is not a valid integer. Set PORT in .env to a number." >&2
  exit 1
fi
echo "Using PORT=${PORT}"

# Create (or update) ConfigMap from .env if present
if [ -f .env ]; then
  echo "Applying ConfigMap from .env to namespace default (configmap: sootio-config)"
  kubectl create configmap sootio-config --from-env-file=.env --dry-run=client -o yaml | kubectl apply -f -
else
  echo "No .env file to create ConfigMap from; skipping ConfigMap creation."
fi

# 3. Update the Kubernetes deployment with the image name
# This step is temporary and will be replaced by a better solution in the future.
echo "Updating Kubernetes deployment with image: $IMAGE_NAME..."
# Use a temporary file for sed to ensure compatibility with both GNU and BSD sed.
TMP_DEPLOYMENT=$(mktemp)
cp k8s/deployment.yml "$TMP_DEPLOYMENT"
sed -i.bak "s|image: YOUR_IMAGE_NAME_HERE|image: $IMAGE_NAME|g" "$TMP_DEPLOYMENT"

# 4. Apply the Kubernetes manifests
echo "Applying Kubernetes manifests..."
kubectl apply -f "$TMP_DEPLOYMENT"

# Clean up the temporary file
rm "$TMP_DEPLOYMENT"
rm "$TMP_DEPLOYMENT.bak"

echo "
Deployment successful!"

if [ "$NO_PORT_FORWARD" = false ]; then
    echo "Starting port-forward in the background using nohup..."
    echo "You will be able to access the application at http://localhost:${PORT} (and on other machines at http://<your-ip>:${PORT})"
    echo "The output of the command will be written to nohup.out"
    echo "To stop the port-forwarding, find the process ID and kill it. (e.g., pgrep -f 'kubectl port-forward' | xargs kill)"
    nohup kubectl port-forward --address 0.0.0.0 service/sootio-service ${PORT}:80 &
fi


# --- Post-deployment steps ---

echo "
Next steps:

1. Check the status of the deployment:
   kubectl get deployments

2. Check the status of the pods:
   kubectl get pods

3. To access the service, run:
   kubectl port-forward service/sootio-service <local-port>:${PORT}
   (e.g., kubectl port-forward service/sootio-service 8080:${PORT})
"