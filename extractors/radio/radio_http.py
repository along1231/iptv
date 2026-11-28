import subprocess


def fetch(url):
    args = ["curl", "--fail", "--silent", "--show-error", "--location",
            "--max-time", "20", "--retry", "1", "--", url]
    try:
        return subprocess.check_output(args)
    except subprocess.CalledProcessError as error:
        # Some broadcaster origins close an established GET without sending the body.
        if error.returncode not in (18, 52, 55, 56):
            raise
        return subprocess.check_output(args)
